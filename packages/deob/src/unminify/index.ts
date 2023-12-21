import { parse } from '@babel/parser'
import type {
  Transform,
} from '../ast-utils'
import {
  applyTransform,
  applyTransforms,
  generate,
} from '../ast-utils'
import * as transforms from './transforms'

export const unminify = {
  name: 'unminify',
  tags: ['safe'],
  scope: true,
  run(ast, state) {
    state.changes += applyTransforms(ast, Object.values(transforms), {
      log: false,
    }).changes
  },
} satisfies Transform

export function unminifySource(code: string): string {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  })

  applyTransform(ast, unminify)

  return generate(ast)
}
