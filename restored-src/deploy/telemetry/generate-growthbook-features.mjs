#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

const scriptPath = fileURLToPath(import.meta.url)
const deployDir = path.dirname(scriptPath)
const repoRoot = path.resolve(deployDir, '..', '..')
const outPath = path.join(deployDir, 'claude-growthbook-features.generated.json')

const FEATURE_VALUE_FNS = new Set([
  'getFeatureValue_CACHED_MAY_BE_STALE',
  'getFeatureValue_CACHED_WITH_REFRESH',
  'getFeatureValue_DEPRECATED',
  'getFeatureValueInternal',
  'getDynamicConfig_CACHED_MAY_BE_STALE',
  'getDynamicConfig_BLOCKS_ON_INIT',
  'useDynamicConfig',
])

const BOOLEAN_GATE_FNS = new Set([
  'checkStatsigFeatureGate_CACHED_MAY_BE_STALE',
  'checkSecurityRestrictionGate',
  'checkGate_CACHED_OR_BLOCKING',
])

const argv = new Set(process.argv.slice(2))
const write = argv.has('--write')
const stdout = argv.has('--stdout')

function run(command, args, options = {}) {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

function listSourceFiles() {
  return run('rg', ['--files', 'src', '--glob', '*.{ts,tsx,js,jsx}'])
    .trim()
    .split('\n')
    .filter(Boolean)
}

function expressionText(node, sourceFile) {
  return node.getText(sourceFile)
}

function collectLocalConstants(sourceFile) {
  const constants = new Map()

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = evalStatic(node.initializer, sourceFile, constants)
      if (value.resolved) {
        constants.set(node.name.text, value.value)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return constants
}

function evalStatic(node, sourceFile, constants) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { resolved: true, value: node.text }
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { resolved: true, value: true }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { resolved: true, value: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { resolved: true, value: null }
  if (ts.isNumericLiteral(node)) return { resolved: true, value: Number(node.text) }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return { resolved: true, value: -Number(node.operand.text) }
  }
  if (ts.isIdentifier(node) && constants.has(node.text)) {
    return { resolved: true, value: constants.get(node.text) }
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalStatic(node.expression, sourceFile, constants)
  }
  if (ts.isParenthesizedExpression(node)) {
    return evalStatic(node.expression, sourceFile, constants)
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = []
    for (const element of node.elements) {
      const value = evalStatic(element, sourceFile, constants)
      if (!value.resolved) return { resolved: false }
      values.push(value.value)
    }
    return { resolved: true, value: values }
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return { resolved: false }
      const name = property.name
      let key
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        key = name.text
      } else {
        return { resolved: false }
      }
      const value = evalStatic(property.initializer, sourceFile, constants)
      if (!value.resolved) return { resolved: false }
      object[key] = value.value
    }
    return { resolved: true, value: object }
  }
  return {
    resolved: false,
    raw: expressionText(node, sourceFile),
  }
}

function getCallName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

function getLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function valueType(value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'json'
}

function addFeature(features, call) {
  const existing = features.get(call.key)
  if (!existing) {
    features.set(call.key, {
      key: call.key,
      defaults: [{ value: call.defaultValue, raw: call.defaultRaw }],
      calls: [call.call],
      valueType: valueType(call.defaultValue),
      defaultValue: call.defaultValue,
      conflict: false,
    })
    return
  }

  existing.calls.push(call.call)
  if (!existing.defaults.some(d => JSON.stringify(d.value) === JSON.stringify(call.defaultValue))) {
    existing.defaults.push({ value: call.defaultValue, raw: call.defaultRaw })
    existing.conflict = true
  }
  if (existing.valueType !== valueType(call.defaultValue)) {
    existing.conflict = true
  }
}

const features = new Map()
const unresolved = []

for (const relFile of listSourceFiles()) {
  const absFile = path.join(repoRoot, relFile)
  const sourceText = fs.readFileSync(absFile, 'utf8')
  const sourceFile = ts.createSourceFile(
    relFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relFile.endsWith('.tsx') || relFile.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  )
  const constants = collectLocalConstants(sourceFile)

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const fn = getCallName(node.expression)
      if (fn && (FEATURE_VALUE_FNS.has(fn) || BOOLEAN_GATE_FNS.has(fn))) {
        const keyArg = node.arguments[0]
        const key = keyArg ? evalStatic(keyArg, sourceFile, constants) : { resolved: false }
        if (!key.resolved || typeof key.value !== 'string') {
          unresolved.push({
            file: relFile,
            line: getLine(sourceFile, node),
            fn,
            arg: keyArg ? expressionText(keyArg, sourceFile) : '<missing>',
          })
        } else if (BOOLEAN_GATE_FNS.has(fn)) {
          addFeature(features, {
            key: key.value,
            defaultValue: false,
            defaultRaw: 'false',
            call: {
              file: relFile,
              line: getLine(sourceFile, node),
              fn,
              defaultRaw: 'false',
            },
          })
        } else {
          const defaultArg = node.arguments[1]
          const defaultValue = defaultArg
            ? evalStatic(defaultArg, sourceFile, constants)
            : { resolved: false }
          if (!defaultValue.resolved) {
            unresolved.push({
              file: relFile,
              line: getLine(sourceFile, node),
              fn,
              key: key.value,
              defaultRaw: defaultArg ? expressionText(defaultArg, sourceFile) : '<missing>',
            })
          } else {
            addFeature(features, {
              key: key.value,
              defaultValue: defaultValue.value,
              defaultRaw: defaultArg ? expressionText(defaultArg, sourceFile) : 'undefined',
              call: {
                file: relFile,
                line: getLine(sourceFile, node),
                fn,
                defaultRaw: defaultArg ? expressionText(defaultArg, sourceFile) : 'undefined',
              },
            })
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

const payload = {
  generatedAt: new Date().toISOString(),
  sourceRoot: path.basename(repoRoot),
  features: [...features.values()].sort((a, b) => a.key.localeCompare(b.key)),
  unresolved: unresolved.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
}

if (write) {
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`)
}

if (stdout || !write) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log(
    `Wrote ${path.relative(repoRoot, outPath)} with ${payload.features.length} features and ${payload.unresolved.length} unresolved call sites.`,
  )
}
