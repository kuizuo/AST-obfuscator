import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import { describe, expect, it } from 'vitest'
import { renameFast, renameParameters } from '../rename'

describe('rename variable', () => {
  it('conflict with existing binding', () => {
    const ast = parse('let a = 1; let b = a;')
    traverse(ast, {
      Program(path) {
        const binding = path.scope.getBinding('a')!
        renameFast(binding, 'b')

        expect(path.scope.bindings).keys('b', '_b')
      },
    })
    expect(ast).toMatchInlineSnapshot(`
      let b = 1;
      let _b = b;
    `)
  })

  it('different types of assignments', () => {
    const ast = parse(`
      var a = 1;
      var a = 2;
      a++;
      [a] = [2];
      ({...a} = {});
      for (a of []);
      for (a in []);
    `)
    traverse(ast, {
      Program(path) {
        const binding = path.scope.getBinding('a')!
        renameFast(binding, 'b')
      },
    })
    expect(ast).toMatchInlineSnapshot(`
      var b = 1;
      var b = 2;
      b++;
      [b] = [2];
      ({
        ...b
      } = {});
      for (b of []);
      for (b in []);
    `)
  })
})

describe('rename parameters', () => {
  it('fewer than specified', () => {
    const ast = parse('function f(a, b, c) { a + b + c;}')
    traverse(ast, {
      Function(path) {
        renameParameters(path, ['x', 'y'])
      },
    })
    expect(ast).toMatchInlineSnapshot(`
      function f(x, y, c) {
        x + y + c;
      }
    `)
  })

  it('more than specified', () => {
    const ast = parse('function f(a, b, c) { a + b + c;}')
    traverse(ast, {
      Function(path) {
        renameParameters(path, ['x', 'y', 'z', 'w'])
      },
    })
    expect(ast).toMatchInlineSnapshot(`
      function f(x, y, z) {
        x + y + z;
      }
    `)
  })
})
