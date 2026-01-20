# Contributing to ralph_codes

We welcome contributions to ralph_codes! This document outlines the process for contributing to this project.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0

### Setting Up Development Environment

1. Fork the repository
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ralph_codes.git
   cd ralph_codes
   ```
3. Install dependencies:
   ```bash
   cd ralph-wiggum-plugin
   npm install
   ```

## Development Workflow

### 1. Create a Branch

Create a new branch for your feature or bug fix:

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes

Make your changes to the codebase. Follow the existing code style and conventions.

### 3. Test Your Changes

Ensure your changes work correctly:

```bash
npm run build
npm test
```

### 4. Commit Your Changes

Write a clear commit message describing your changes:

```bash
git add .
git commit -m "feat: add new feature description"
```

### 5. Push and Create PR

Push your branch and create a Pull Request:

```bash
git push origin feature/your-feature-name
```

Then open a Pull Request on GitHub.

## Code Style

- Use TypeScript for all new code
- Follow the existing formatting (Prettier/ESLint)
- Write tests for new functionality
- Update documentation as needed

## Submitting Changes

1. Ensure all tests pass
2. Update relevant documentation
3. Submit a clear, detailed Pull Request description
4. Link any related issues

## Reporting Issues

When reporting issues, please include:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)
- Error messages or screenshots if applicable

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.
