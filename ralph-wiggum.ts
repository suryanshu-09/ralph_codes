import { type Plugin, tool } from "@opencode-ai/plugin"

interface RalphTask {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "failed"
  sessionId?: string
  error?: string
  dependencies?: string[] // Task IDs this task depends on
  outputs?: string[] // What this task produces (for dependency resolution)
}

interface ModelConfig {
  providerID: string
  modelID: string
}

interface RalphLoop {
  id: string
  originalPrompt: string
  tasks: RalphTask[]
  currentTaskIndex: number
  createdAt: number
  model?: ModelConfig
  running: boolean
}

interface TaskWithDeps {
  id: string
  content: string
  dependencies: string[]
  outputs: string[]
}

// In-memory state
let activeLoop: RalphLoop | null = null
let lastKnownTodos: any[] = []

// Default model for all ralph operations
const DEFAULT_MODEL: ModelConfig = {
  providerID: "opencode",
  modelID: "minimax-m2.1-free",
}

// Parse model string "provider/model" into ModelConfig
const parseModelString = (modelStr: string): ModelConfig | null => {
  const parts = modelStr.split("/")
  if (parts.length >= 2) {
    return {
      providerID: parts[0],
      modelID: parts.slice(1).join("/"),
    }
  }
  return null
}

// Analyze dependencies between tasks based on content
const analyzeDependencies = (tasks: TaskWithDeps[]): Map<string, string[]> => {
  const dependencyMap = new Map<string, string[]>()
  
  // Common patterns that indicate dependencies
  const outputPatterns = [
    /create\s+(?:the\s+)?(\w+)/gi,
    /implement\s+(?:the\s+)?(\w+)/gi,
    /build\s+(?:the\s+)?(\w+)/gi,
    /setup\s+(?:the\s+)?(\w+)/gi,
    /initialize\s+(?:the\s+)?(\w+)/gi,
    /add\s+(?:the\s+)?(\w+)/gi,
    /write\s+(?:the\s+)?(\w+)/gi,
  ]
  
  const inputPatterns = [
    /use\s+(?:the\s+)?(\w+)/gi,
    /with\s+(?:the\s+)?(\w+)/gi,
    /using\s+(?:the\s+)?(\w+)/gi,
    /integrate\s+(?:the\s+)?(\w+)/gi,
    /connect\s+(?:to\s+)?(?:the\s+)?(\w+)/gi,
    /test\s+(?:the\s+)?(\w+)/gi,
    /update\s+(?:the\s+)?(\w+)/gi,
  ]
  
  // Extract what each task produces
  const taskOutputs = new Map<string, Set<string>>()
  for (const task of tasks) {
    const outputs = new Set<string>()
    for (const pattern of outputPatterns) {
      const matches = task.content.matchAll(pattern)
      for (const match of matches) {
        if (match[1]) outputs.add(match[1].toLowerCase())
      }
    }
    taskOutputs.set(task.id, outputs)
  }
  
  // Determine dependencies based on inputs matching outputs
  for (const task of tasks) {
    const deps: string[] = []
    const inputs = new Set<string>()
    
    for (const pattern of inputPatterns) {
      const matches = task.content.matchAll(pattern)
      for (const match of matches) {
        if (match[1]) inputs.add(match[1].toLowerCase())
      }
    }
    
    // Check if any previous task produces what this task needs
    for (const otherTask of tasks) {
      if (otherTask.id === task.id) continue
      const otherOutputs = taskOutputs.get(otherTask.id) || new Set()
      
      for (const input of inputs) {
        if (otherOutputs.has(input)) {
          deps.push(otherTask.id)
          break
        }
      }
    }
    
    dependencyMap.set(task.id, deps)
  }
  
  return dependencyMap
}

// Build execution layers - tasks in same layer can run in parallel
const buildExecutionLayers = (tasks: RalphTask[]): RalphTask[][] => {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const completed = new Set<string>()
  const layers: RalphTask[][] = []
  const remaining = new Set(tasks.map(t => t.id))
  
  // Safety limit to prevent infinite loops
  let iterations = 0
  const maxIterations = tasks.length + 1
  
  while (remaining.size > 0 && iterations < maxIterations) {
    iterations++
    const layer: RalphTask[] = []
    
    for (const taskId of remaining) {
      const task = taskMap.get(taskId)!
      const deps = task.dependencies || []
      
      // Check if all dependencies are completed
      const allDepsCompleted = deps.every(dep => completed.has(dep))
      if (allDepsCompleted) {
        layer.push(task)
      }
    }
    
    // If no tasks can be added (circular dependency or other issue), 
    // add all remaining as a single sequential layer
    if (layer.length === 0 && remaining.size > 0) {
      for (const taskId of remaining) {
        layer.push(taskMap.get(taskId)!)
      }
    }
    
    // Mark layer tasks as completed and remove from remaining
    for (const task of layer) {
      completed.add(task.id)
      remaining.delete(task.id)
    }
    
    if (layer.length > 0) {
      layers.push(layer)
    }
  }
  
  return layers
}

export const RalphWiggumPlugin: Plugin = async ({ client }) => {

  // Get the model from a session by fetching its messages
  const getSessionModel = async (sessionId: string): Promise<ModelConfig | undefined> => {
    try {
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
        query: { limit: 1 },
      })
      const messages = messagesResponse?.data
      if (messages && messages.length > 0) {
        const latestMessage = messages[0]
        if (latestMessage.info.role === "user" && latestMessage.info.model) {
          return {
            providerID: latestMessage.info.model.providerID,
            modelID: latestMessage.info.model.modelID,
          }
        }
        if (latestMessage.info.role === "assistant") {
          return {
            providerID: latestMessage.info.providerID,
            modelID: latestMessage.info.modelID,
          }
        }
      }
    } catch (e) {
      // Fall back to default
    }
    return undefined
  }

  // Execute a single task in a fresh session with strict scoping
  const executeTask = async (task: RalphTask, loop: RalphLoop, taskIndex: number, totalTasks: number): Promise<void> => {
    try {
      // Create a fresh session for this task
      const sessionResponse = await client.session.create({ body: {} })
      const session = sessionResponse?.data
      if (!session) {
        task.status = "failed"
        task.error = "Failed to create session"
        return
      }
      task.sessionId = session.id
      task.status = "in_progress"

      // Strict worker prompt that enforces boundaries
      const workerPrompt = `# SINGLE TASK EXECUTION - STRICT BOUNDARIES

## YOUR ONLY TASK (Task ${taskIndex}/${totalTasks})
${task.content}

## ORIGINAL PROJECT CONTEXT
"${loop.originalPrompt}"

## CRITICAL RULES - READ CAREFULLY
1. **ONLY** complete the task described above - nothing else
2. **DO NOT** work on any other tasks from the project
3. **DO NOT** anticipate or prepare for future tasks
4. **DO NOT** refactor or improve code outside your task scope
5. **STOP** immediately when your specific task is complete

## WHAT YOU MUST DO
- Focus exclusively on: "${task.content}"
- Complete this single task thoroughly
- Test your specific changes if applicable
- Document only what you created/modified

## COMPLETION
When done, output exactly:
\`\`\`
TASK_COMPLETE
Summary: [1-2 sentence summary of what was done]
Files: [list of files created/modified]
\`\`\`

## BEGIN
Start working on your task now. Remember: ONLY this task, nothing more.`

      // session.prompt() waits for the full response
      await client.session.prompt({
        path: { id: session.id },
        body: {
          ...(loop.model ? { model: loop.model } : {}),
          parts: [{ type: "text", text: workerPrompt }],
        },
      })

      task.status = "completed"
    } catch (e) {
      task.status = "failed"
      task.error = e instanceof Error ? e.message : String(e)
    }
  }

  // Execute multiple tasks in parallel
  const executeTasksParallel = async (tasks: RalphTask[], loop: RalphLoop, startIndex: number, totalTasks: number): Promise<void> => {
    const promises = tasks.map((task, i) => 
      executeTask(task, loop, startIndex + i + 1, totalTasks)
    )
    await Promise.all(promises)
  }

  // Use an AI session to break down a prompt into atomic tasks with dependencies
  const breakDownPrompt = async (prompt: string, model?: ModelConfig): Promise<TaskWithDeps[]> => {
    // Create a planning session
    const sessionResponse = await client.session.create({ body: {} })
    const session = sessionResponse?.data
    if (!session) {
      throw new Error("Failed to create planning session")
    }

    const planningPrompt = `You are an expert task planner for software engineering projects. Break down this request into ATOMIC, INDEPENDENT tasks.

## Request
${prompt}

## CRITICAL RULES FOR TASK BREAKDOWN

### 1. ATOMIC TASKS
Each task MUST be:
- Completable in a single focused session (15-30 min of work)
- Self-contained with clear boundaries
- Specific enough that there's no ambiguity about scope

### 2. INDEPENDENCE
- Tasks that don't depend on each other should be marked as independent
- Use [DEPENDS: task_ids] to mark dependencies
- Independent tasks will run IN PARALLEL for speed

### 3. STRICT FORMAT
Output ONLY a numbered list in this EXACT format:
\`\`\`
1. [Task description] | DEPENDS: none | OUTPUTS: [what this creates]
2. [Task description] | DEPENDS: 1 | OUTPUTS: [what this creates]
3. [Task description] | DEPENDS: none | OUTPUTS: [what this creates]
4. [Task description] | DEPENDS: 2,3 | OUTPUTS: [what this creates]
\`\`\`

### 4. EXAMPLES OF GOOD VS BAD TASKS

BAD (too broad):
- "Implement the backend" 
- "Create the UI"

GOOD (atomic):
- "Create User model with fields: id, email, password_hash, created_at"
- "Implement POST /api/auth/login endpoint that validates credentials and returns JWT"
- "Create LoginForm component with email and password inputs"

### 5. PARALLELIZATION HINTS
- File/module creation tasks are often independent
- Tests usually depend on the code they test
- Integration tasks depend on the components they integrate

## OUTPUT
Now break down the request into atomic tasks with dependencies:
\`\`\`
`

    await client.session.prompt({
      path: { id: session.id },
      body: {
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: planningPrompt }],
      },
    })

    // Extract the response
    const messages = await client.session.messages({
      path: { id: session.id },
      query: { limit: 10 },
    })
    
    const assistantMessage = messages?.data?.find(m => m.info.role === "assistant")
    if (!assistantMessage) {
      throw new Error("No response from planning session")
    }

    const textParts = assistantMessage.parts.filter(p => p.type === "text")
    const responseText = textParts.map(p => (p as any).text || "").join("\n")

    // Parse the structured format
    const lines = responseText.split("\n")
    const tasks: TaskWithDeps[] = []
    
    for (const line of lines) {
      // Match: "1. Task description | DEPENDS: 1,2 | OUTPUTS: something"
      const fullMatch = line.match(/^\d+[\.\)]\s*(.+?)\s*\|\s*DEPENDS:\s*([\w,\s]+)\s*\|\s*OUTPUTS:\s*(.+)$/i)
      if (fullMatch) {
        const content = fullMatch[1].trim()
        const depsStr = fullMatch[2].trim().toLowerCase()
        const outputs = fullMatch[3].trim()
        
        const deps = depsStr === "none" ? [] : 
          depsStr.split(",").map(d => d.trim()).filter(d => d && d !== "none")
        
        tasks.push({
          id: `task_${tasks.length + 1}`,
          content,
          dependencies: deps.map(d => `task_${d}`),
          outputs: [outputs],
        })
        continue
      }
      
      // Fallback: simple numbered list
      const simpleMatch = line.match(/^\d+[\.\)]\s*(.+)/)
      if (simpleMatch && simpleMatch[1].trim()) {
        const content = simpleMatch[1].trim()
        // Don't add if it looks like format instructions
        if (!content.includes("DEPENDS:") && !content.includes("OUTPUTS:") && content.length > 10) {
          tasks.push({
            id: `task_${tasks.length + 1}`,
            content,
            dependencies: [],
            outputs: [],
          })
        }
      }
    }

    // If we didn't get structured dependencies, analyze them
    if (tasks.length > 0 && tasks.every(t => t.dependencies.length === 0)) {
      const depMap = analyzeDependencies(tasks)
      for (const task of tasks) {
        task.dependencies = depMap.get(task.id) || []
      }
    }

    return tasks
  }

  return {
    event: async ({ event }) => {
      if (event.type === "todo.updated" && event.properties) {
        lastKnownTodos = event.properties.todos || []
      }
    },

    tool: {
      // === FIRE-AND-FORGET: Single command that does everything with parallelization ===
      ralph_auto: tool({
        description: "Fully automatic Ralph loop - provide a prompt, and this will break it down into tasks and execute them all in fresh sessions. No further interaction needed. Perfect for 'opencode run' or fire-and-forget usage.",
        args: {
          prompt: tool.schema.string().describe("The complex task to break down and execute"),
          model: tool.schema.string().optional().describe("Model to use (format: provider/model). Defaults to current session's model."),
        },
        async execute({ prompt, model }, ctx) {
          let modelConfig: ModelConfig
          
          if (model) {
            modelConfig = parseModelString(model) || DEFAULT_MODEL
          } else {
            modelConfig = await getSessionModel(ctx.sessionID) || DEFAULT_MODEL
          }

          const modelInfo = `${modelConfig.providerID}/${modelConfig.modelID}`

          const results: string[] = []
          results.push(`Ralph Auto-Loop Starting`)
          results.push(`=========================`)
          results.push(`Prompt: "${prompt}"`)
          results.push(`Model: ${modelInfo}`)
          results.push(``)

          // Step 1: Break down the prompt into tasks with dependencies
          results.push(`Step 1: Planning tasks with dependency analysis...`)
          let taskDescriptions: TaskWithDeps[]
          try {
            taskDescriptions = await breakDownPrompt(prompt, modelConfig)
          } catch (e) {
            return `Failed to break down prompt: ${e instanceof Error ? e.message : String(e)}`
          }

          if (taskDescriptions.length === 0) {
            return `Failed to extract tasks from planning session. Please try again or use ralph_start for manual task definition.`
          }

          results.push(`Identified ${taskDescriptions.length} tasks:`)
          taskDescriptions.forEach((t, i) => {
            const deps = t.dependencies.length > 0 ? ` [depends: ${t.dependencies.join(", ")}]` : " [independent]"
            results.push(`  ${i + 1}. ${t.content}${deps}`)
          })
          results.push(``)

          // Step 2: Create the loop with dependency info
          const loop: RalphLoop = {
            id: `ralph_auto_${Date.now()}`,
            originalPrompt: prompt,
            tasks: taskDescriptions.map((t) => ({
              id: t.id,
              content: t.content,
              status: "pending" as const,
              dependencies: t.dependencies,
              outputs: t.outputs,
            })),
            currentTaskIndex: -1,
            createdAt: Date.now(),
            model: modelConfig,
            running: true,
          }

          activeLoop = loop

          // Step 3: Build execution layers for parallelization
          const layers = buildExecutionLayers(loop.tasks)
          
          results.push(`Step 2: Executing tasks (${layers.length} parallel layers)...`)
          results.push(``)

          let taskCounter = 0
          for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
            const layer = layers[layerIdx]
            const parallelCount = layer.length
            
            results.push(`=== Layer ${layerIdx + 1}/${layers.length} (${parallelCount} task${parallelCount > 1 ? "s in parallel" : ""}) ===`)
            
            if (parallelCount > 1) {
              results.push(`Running ${parallelCount} tasks in PARALLEL...`)
            }

            // Execute layer tasks in parallel
            await executeTasksParallel(layer, loop, taskCounter, loop.tasks.length)

            // Report results for this layer
            for (const task of layer) {
              taskCounter++
              results.push(``)
              results.push(`--- Task ${taskCounter}/${loop.tasks.length} ---`)
              results.push(`Task: ${task.content}`)
              
              if (task.status === "completed") {
                results.push(`Session: ${task.sessionId}`)
                results.push(`Status: COMPLETED`)
              } else {
                results.push(`Session: ${task.sessionId || "N/A"}`)
                results.push(`Status: FAILED - ${task.error || "Unknown error"}`)
              }
            }
            results.push(``)
          }

          loop.running = false

          // Summary
          const completedCount = loop.tasks.filter(t => t.status === "completed").length
          const failedCount = loop.tasks.filter(t => t.status === "failed").length
          
          results.push(`=========================`)
          results.push(`Ralph Auto-Loop Complete`)
          results.push(`=========================`)
          results.push(`Completed: ${completedCount}/${loop.tasks.length}`)
          if (failedCount > 0) results.push(`Failed: ${failedCount}`)
          results.push(`Parallel layers used: ${layers.length}`)
          results.push(``)
          results.push(`Sessions created:`)
          loop.tasks.forEach((t, i) => {
            results.push(`  ${i + 1}. [${t.status}] ${t.sessionId || "N/A"}`)
          })

          activeLoop = null
          return results.join("\n")
        },
      }),

      // === ORCHESTRATED: Traditional multi-step approach ===
      ralph_start: tool({
        description: "Start a Ralph Wiggum loop - you (the orchestrator) will create a todo list, then spawn fresh sessions for each task sequentially. By default, worker sessions use the same model as the orchestrator.",
        args: {
          prompt: tool.schema.string().describe("The task prompt to break down and execute"),
          model: tool.schema.string().optional().describe("Model to use for worker sessions (format: provider/model, e.g. 'anthropic/claude-opus-4-5-20250929'). If not specified, uses the orchestrator's current model."),
        },
        async execute({ prompt, model }, ctx) {
          lastKnownTodos = []
          
          let modelConfig: ModelConfig
          
          if (model) {
            modelConfig = parseModelString(model) || DEFAULT_MODEL
          } else {
            modelConfig = await getSessionModel(ctx.sessionID) || DEFAULT_MODEL
          }
          
          activeLoop = {
            id: `ralph_${Date.now()}`,
            originalPrompt: prompt,
            tasks: [],
            currentTaskIndex: -1,
            createdAt: Date.now(),
            model: modelConfig,
            running: false,
          }

          const modelInfo = `${modelConfig.providerID}/${modelConfig.modelID}`

          return `Ralph Wiggum loop initialized.

## Your Task
"${prompt}"

## Model
Worker sessions will use: ${modelInfo}
${model ? "(explicitly specified)" : "(default: opencode/minimax-m2.1-free)"}

## Next Steps (you are the orchestrator)
1. Use \`ralph_add_tasks\` to add ATOMIC tasks with dependencies
2. Then call \`ralph_run\` to begin - independent tasks will run IN PARALLEL
3. You'll stay in control and monitor progress

## Task Format
When adding tasks, you can specify dependencies:
- Tasks with no dependencies will run in parallel
- Tasks with dependencies wait for those to complete

Create the task list now using ralph_add_tasks.`
        },
      }),

      ralph_add_tasks: tool({
        description: "Add tasks directly to the Ralph loop. Use this after ralph_start to add tasks that will be executed. Tasks can include dependencies for automatic parallelization.",
        args: {
          tasks: tool.schema.array(tool.schema.object({
            id: tool.schema.string().describe("Unique task ID (e.g., 'task_1', 'setup', 'tests')"),
            content: tool.schema.string().describe("Task description - be specific and atomic"),
            dependencies: tool.schema.array(tool.schema.string()).optional().describe("Array of task IDs this task depends on. Empty = independent = can run in parallel"),
          })).describe("Array of tasks to add"),
        },
        async execute({ tasks }, ctx) {
          if (!activeLoop) {
            return "Error: No active Ralph loop. Call ralph_start first."
          }

          for (const task of tasks) {
            activeLoop.tasks.push({
              id: task.id,
              content: task.content,
              status: "pending",
              dependencies: task.dependencies || [],
            })
          }

          // Analyze parallelization potential
          const layers = buildExecutionLayers(activeLoop.tasks)
          const parallelTasks = layers.filter(l => l.length > 1).reduce((sum, l) => sum + l.length, 0)

          return `Added ${tasks.length} tasks to Ralph loop. Total tasks: ${activeLoop.tasks.length}

## Execution Plan
- Total layers: ${layers.length}
- Tasks that can run in parallel: ${parallelTasks}
- Sequential bottlenecks: ${layers.filter(l => l.length === 1).length}

## Tasks:
${activeLoop.tasks.map((t, i) => {
  const deps = t.dependencies && t.dependencies.length > 0 ? ` [depends: ${t.dependencies.join(", ")}]` : " [independent]"
  return `  ${i + 1}. [${t.status}] ${t.content}${deps}`
}).join("\n")}

## Execution Layers (parallel groups):
${layers.map((layer, i) => `  Layer ${i + 1}: ${layer.map(t => t.id).join(", ")} ${layer.length > 1 ? "(PARALLEL)" : ""}`).join("\n")}

Call \`ralph_run\` to start executing. Independent tasks will run in parallel!`
        },
      }),

      ralph_run: tool({
        description: "Run the Ralph loop - executes tasks with automatic parallelization based on dependencies. Independent tasks run in parallel, dependent tasks wait for their dependencies.",
        args: {},
        async execute(args, ctx) {
          if (!activeLoop) {
            return "Error: No active Ralph loop. Call ralph_start first."
          }

          if (activeLoop.running) {
            return "Error: Ralph loop is already running. Use ralph_status to check progress."
          }

          // Try to use tasks already added via ralph_add_tasks
          // If none, try to use the lastKnownTodos from events
          if (activeLoop.tasks.length === 0 && lastKnownTodos.length > 0) {
            activeLoop.tasks = lastKnownTodos
              .filter((t: any) => t.status === "pending" || t.status === "in_progress")
              .map((t: any, i: number) => ({
                id: t.id || `task_${i + 1}`,
                content: t.content,
                status: "pending" as const,
                dependencies: [] as string[],
              }))
            
            // Analyze dependencies for todo-based tasks
            const taskWithDeps = activeLoop.tasks.map(t => ({
              id: t.id,
              content: t.content,
              dependencies: [] as string[],
              outputs: [] as string[],
            }))
            const depMap = analyzeDependencies(taskWithDeps)
            for (const task of activeLoop.tasks) {
              task.dependencies = depMap.get(task.id) || []
            }
          }

          if (activeLoop.tasks.length === 0) {
            return `Error: No tasks found in Ralph loop. 

You need to add tasks first using one of these methods:
1. Use \`ralph_add_tasks\` to add tasks directly to the loop (recommended)
2. Use \`TodoWrite\` tool to create a todo list

Example with ralph_add_tasks:
Call ralph_add_tasks with tasks: [
  { id: "1", content: "Create project structure", dependencies: [] },
  { id: "2", content: "Implement feature A", dependencies: [] },
  { id: "3", content: "Implement feature B", dependencies: [] },
  { id: "4", content: "Integrate A and B", dependencies: ["2", "3"] }
]

Tasks 2 and 3 will run in PARALLEL since they have no dependencies on each other!`
          }

          const pendingTasks = activeLoop.tasks.filter(t => t.status === "pending")
          if (pendingTasks.length === 0) {
            return "No pending tasks to run. All tasks may already be completed."
          }

          const results: string[] = []
          
          // Build execution layers
          const layers = buildExecutionLayers(activeLoop.tasks.filter(t => t.status === "pending"))
          
          results.push(`Starting Ralph loop with ${pendingTasks.length} pending tasks...`)
          results.push(`Execution plan: ${layers.length} layers with parallelization\n`)

          const loop = activeLoop
          loop.running = true

          let taskCounter = 0
          for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
            const layer = layers[layerIdx]
            const parallelCount = layer.length
            
            results.push(`\n=== Layer ${layerIdx + 1}/${layers.length} (${parallelCount} task${parallelCount > 1 ? "s in parallel" : ""}) ===`)
            
            if (parallelCount > 1) {
              results.push(`Executing ${parallelCount} tasks in PARALLEL...`)
            }

            // Execute layer tasks in parallel
            await executeTasksParallel(layer, loop, taskCounter, loop.tasks.length)

            // Report results for this layer
            for (const task of layer) {
              taskCounter++
              results.push(`\n--- Task ${taskCounter}/${loop.tasks.length} ---`)
              results.push(`Task: ${task.content}`)
              
              if (task.status === "completed") {
                results.push(`Session: ${task.sessionId}`)
                results.push(`Status: COMPLETED`)
              } else {
                results.push(`Session: ${task.sessionId || "N/A"}`)
                results.push(`Status: FAILED - ${task.error || "Unknown error"}`)
              }
            }
          }

          loop.running = false

          const completedCount = loop.tasks.filter(t => t.status === "completed").length
          const failedCount = loop.tasks.filter(t => t.status === "failed").length
          
          results.push(`\n--- Ralph Loop Complete ---`)
          results.push(`Completed: ${completedCount}/${loop.tasks.length}`)
          if (failedCount > 0) results.push(`Failed: ${failedCount}`)
          results.push(`Parallel execution layers: ${layers.length}`)
          results.push(`\n<ralph_done>Processed ${loop.tasks.length} tasks</ralph_done>`)

          activeLoop = null
          return results.join("\n")
        },
      }),

      ralph_status: tool({
        description: "Check the status of the current Ralph loop",
        args: {},
        async execute(args, ctx) {
          if (!activeLoop) {
            return "No active Ralph loop."
          }

          const pending = activeLoop.tasks.filter(t => t.status === "pending").length
          const inProgress = activeLoop.tasks.filter(t => t.status === "in_progress").length
          const completed = activeLoop.tasks.filter(t => t.status === "completed").length
          const failed = activeLoop.tasks.filter(t => t.status === "failed").length
          
          const modelInfo = activeLoop.model 
            ? `${activeLoop.model.providerID}/${activeLoop.model.modelID}`
            : `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`

          // Show parallelization info
          const pendingTasks = activeLoop.tasks.filter(t => t.status === "pending")
          const layers = pendingTasks.length > 0 ? buildExecutionLayers(pendingTasks) : []

          return `Ralph Loop: ${activeLoop.id}
Prompt: "${activeLoop.originalPrompt}"
Model: ${modelInfo}
Running: ${activeLoop.running ? "YES" : "NO"}
Progress: ${completed}/${activeLoop.tasks.length} (${pending} pending, ${inProgress} in progress, ${failed} failed)

Tasks:
${activeLoop.tasks.length > 0 ? activeLoop.tasks.map((t, i) => {
  const deps = t.dependencies && t.dependencies.length > 0 ? ` [depends: ${t.dependencies.join(", ")}]` : ""
  return `  ${i + 1}. [${t.status}] ${t.content}${deps}${t.sessionId ? ` (session: ${t.sessionId})` : ""}${t.error ? ` - Error: ${t.error}` : ""}`
}).join("\n") : "  (no tasks added yet)"}

${layers.length > 0 ? `\nRemaining Execution Layers:\n${layers.map((layer, i) => `  Layer ${i + 1}: ${layer.map(t => t.id).join(", ")} ${layer.length > 1 ? "(PARALLEL)" : ""}`).join("\n")}` : ""}`
        },
      }),

      ralph_help: tool({
        description: "Show help for the Ralph Wiggum technique",
        args: {},
        async execute(args, ctx) {
          return `Ralph Wiggum - Multi-Session Task Runner with Parallelization
Based on: https://ghuntley.com/ralph/

## Two Modes

### 1. Automatic (Fire-and-Forget)
Use \`ralph_auto\` for fully automatic execution:
- Breaks down your prompt into ATOMIC tasks automatically
- Analyzes dependencies between tasks
- Executes INDEPENDENT tasks in PARALLEL
- No further interaction needed

Example:
  ralph_auto "Implement user authentication with JWT"

### 2. Orchestrated (Manual Control)
Use the traditional multi-step approach:
1. ralph_start "prompt" - Initialize the loop
2. ralph_add_tasks [...] - Add tasks with dependencies
3. ralph_run - Execute (parallel where possible)

## Parallelization

Tasks are automatically parallelized based on dependencies:
- Tasks with NO dependencies run in PARALLEL
- Tasks with dependencies wait for those to complete
- Execution happens in "layers" - each layer runs in parallel

Example task structure:
\`\`\`
Task 1: Create models       [no deps]     ─┐
Task 2: Create controllers  [no deps]     ─┼─ Layer 1 (PARALLEL)
Task 3: Create views        [no deps]     ─┘
Task 4: Integration tests   [deps: 1,2,3] ─── Layer 2 (waits)
\`\`\`

## Why Fresh Sessions?
- Prevents context pollution between tasks
- Each task gets full context window
- Failures are isolated
- Tasks stay ATOMIC (one session = one task)

## Strict Task Boundaries
Workers are instructed to:
- ONLY complete their assigned task
- NOT anticipate future tasks
- NOT refactor outside scope
- STOP when their task is done

## Model Selection
Default model: opencode/minimax-m2.1-free
Override with: ralph_auto "task" --model "anthropic/claude-opus-4-5-20250929"

## CLI Usage (Headless)
  opencode run "Use ralph_auto to implement feature X"

## Tools
- ralph_auto "prompt" - Automatic breakdown + parallel execution
- ralph_start "prompt" - Initialize manual loop
- ralph_add_tasks [{id, content, dependencies?}, ...] - Add tasks
- ralph_run - Execute with automatic parallelization
- ralph_status - Check progress
- ralph_help - This help`
        },
      }),
    },
  }
}
