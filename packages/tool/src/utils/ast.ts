import * as t from '@babel/types'
import { generate } from './generator'

export function codePreview(node: t.Node): string {
  const code = generate(node, {
    minified: true,
    shouldPrintComment: () => false,
  })
  if (code.length > 100)
    return `${code.slice(0, 70)} … ${code.slice(-30)}`

  return code
}

export function getPropName(node: t.Node): string {
  if (t.isIdentifier(node))
    return node.name

  if (t.isStringLiteral(node))
    return node.value

  if (t.isNumericLiteral(node))
    return node.value.toString()

  return ''
}
