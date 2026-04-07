---
name: agent-name
description: One-line description of what this agent does
model: sonnet
tools: [Read, Write, Edit, Bash, Grep, Glob, Agent]
---

# Agent: [Name]

## Purpose

[2-3 sentences describing what this agent does and when it should be dispatched.]

## When to Use

- [Trigger condition 1]
- [Trigger condition 2]
- [Trigger condition 3]

## Workflow

### Step 1: [Assess]
[What the agent reads/checks first]

### Step 2: [Analyze]
[How it processes what it found]

### Step 3: [Act]
[What it produces or modifies]

### Step 4: [Report]
[What it returns to the orchestrator/user]

## Inputs

| Input | Source | Required |
|-------|--------|----------|
| [input_name] | [where it comes from] | yes/no |

## Outputs

| Output | Format | Destination |
|--------|--------|-------------|
| [output_name] | [markdown/json/etc] | [where it goes] |

## Boundaries

- **Can**: [list of allowed actions]
- **Cannot**: [list of restricted actions]
- **Escalates when**: [conditions that require human intervention]

## Example

```
Input: [example input]
Output: [example output]
```

---

## Yonasol Agent Catalog (use this template for)

| Agent | Purpose | Pipeline Stage |
|-------|---------|---------------|
| spec-agent | Generate/validate product specs against product.md standard | Stage 2 (Spec) |
| build-agent | Scaffold repos, run builds, fix errors | Stage 3 (Build) |
| security-agent | Scan for secrets, validate auth, check OWASP | Stage 3-4 |
| test-agent | Run TDD workflow, verify coverage | Stage 3 |
| launch-agent | Run deploy checklist, verify production | Stage 4 (Ship) |
