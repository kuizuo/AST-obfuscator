import type { NodePath } from '@babel/traverse'
import type { CallExpression } from '@babel/types'
import { generate } from '../ast-utils'
import type { ArrayRotator } from './array-rotator'

import { Decoder } from './decoder'
import type { StringArray } from './string-array'

export type Sandbox = (code: string) => Promise<unknown>

export function createNodeSandbox(): Sandbox {
  return () => {
    // TODO: use sandybox (not available in web workers though)
    throw new Error('Custom Sandbox implementation required.')
  }

  // return async (code: string) => {
  //   const {
  //     default: { Isolate },
  //   } = await import('isolated-vm')
  //   const isolate = new Isolate()
  //   const context = await isolate.createContext()
  //   const result = (await context.eval(code, {
  //     timeout: 10_000,
  //     copy: true,
  //     filename: 'file:///obfuscated.js',
  //   })) as unknown
  //   context.release()
  //   isolate.dispose()
  //   return result
  // }
}

export function createBrowserSandbox(): Sandbox {
  return () => {
    // TODO: use sandybox (not available in web workers though)
    throw new Error('Custom Sandbox implementation required.')
  }
}

export class VMDecoder {
  decoders: Decoder[]
  private setupCode: string
  private sandbox: Sandbox

  constructor(
    sandbox: Sandbox,
    stringArray: StringArray,
    decoders: Decoder[],
    rotator?: ArrayRotator,
  ) {
    this.sandbox = sandbox
    this.decoders = decoders

    // Generate as compact to bypass the self defense
    // (which tests someFunction.toString against a regex)
    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    }
    const stringArrayCode = generate(stringArray.path.node, generateOptions)
    const rotatorCode = rotator ? generate(rotator.node, generateOptions) : ''
    const decoderCode = decoders
      .map(decoder => generate(decoder.path.node, generateOptions))
      .join(';\n')

    this.setupCode = [stringArrayCode, rotatorCode, decoderCode].join(';\n')
  }

  async decode(calls: NodePath<CallExpression>[]): Promise<unknown[]> {
    const code = `(() => {
      ${this.setupCode}
      return [${calls.join(',')}]
    })()`

    const result = await this.sandbox(code)
    return result as unknown[]
  }
}
