import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

export function generateAsaFixture({ assetId, feeRecipient, outputPath = 'tests/fixtures/asa_localnet.algo.ts' } = {}) {
  if (assetId !== undefined) assert.match(String(assetId), /^[1-9][0-9]*$/)
  if (feeRecipient !== undefined) assert.match(feeRecipient, /^[A-Z2-7]{58}$/)
  assert.match(outputPath, /^tests\/fixtures\/[a-zA-Z0-9_-]+\.algo\.ts$/)
  const source = ts.createSourceFile(
    'contract.algo.ts',
    readFileSync('smart_contracts/leak_swap_asa/contract.algo.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const factory = ts.factory
  let changed = 0
  const result = ts.transform(source, [
    (context) => {
      function visit(node) {
        if (ts.isClassDeclaration(node) && node.name?.text === 'AsaLeakSwap') {
          return factory.updateClassDeclaration(
            node,
            node.modifiers,
            factory.createIdentifier('LocalnetAsaFixture'),
            node.typeParameters,
            node.heritageClauses,
            node.members.map((member) => ts.visitNode(member, visit)),
          )
        }
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === './sponsor_address.algo'
        ) {
          return factory.updateImportDeclaration(
            node,
            node.modifiers,
            node.importClause,
            factory.createStringLiteral('../../smart_contracts/leak_swap_asa/sponsor_address.algo'),
            node.attributes,
          )
        }
        if (
          ts.isMethodDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          ['acceptsAsset', 'feeRecipient'].includes(node.name.text)
        ) {
          changed++
          const expression =
            node.name.text === 'acceptsAsset'
              ? factory.createBinaryExpression(
                  factory.createPropertyAccessExpression(factory.createIdentifier('asset'), 'id'),
                  assetId === undefined ? ts.SyntaxKind.GreaterThanToken : ts.SyntaxKind.EqualsEqualsEqualsToken,
                  factory.createNumericLiteral(assetId === undefined ? 0 : String(assetId)),
                )
              : feeRecipient === undefined
                ? factory.createPropertyAccessExpression(factory.createIdentifier('Global'), 'creatorAddress')
                : factory.createCallExpression(factory.createIdentifier('Account'), undefined, [
                    factory.createStringLiteral(feeRecipient),
                  ])
          return factory.updateMethodDeclaration(
            node,
            node.modifiers,
            node.asteriskToken,
            node.name,
            node.questionToken,
            node.typeParameters,
            node.parameters,
            node.type,
            factory.createBlock([factory.createReturnStatement(expression)], true),
          )
        }
        return ts.visitEachChild(node, visit, context)
      }
      return (root) => ts.visitNode(root, visit)
    },
  ])
  try {
    assert.equal(changed, 2, 'Only the test allowlist and treasury must be substituted')
    mkdirSync('tests/fixtures', { recursive: true })
    writeFileSync(outputPath, ts.createPrinter().printFile(result.transformed[0]))
  } finally {
    result.dispose()
  }
}
