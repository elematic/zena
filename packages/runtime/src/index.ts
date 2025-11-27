export interface ZenaImports {
  env?: Record<string, Function>;
  console?: Record<string, Function>;
  [key: string]: any;
}

/**
 * Instantiate a WebAssembly module with Zena default and user-provided imports.
 * 
 * @param wasm 
 * @param userImports 
 * @returns 
 */
export async function instantiate(
  wasm: BufferSource | WebAssembly.Module,
  userImports: ZenaImports = {}
): Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance> {
  const defaultImports = {
    env: {
      // Default env imports if any
    },
    console: {
      log: (arg: any) => console.log(arg),
      error: (arg: any) => console.error(arg),
      warn: (arg: any) => console.warn(arg),
    },
  };

  const imports = {
    ...defaultImports,
    ...userImports,
    env: { ...defaultImports.env, ...userImports.env },
    console: { ...defaultImports.console, ...userImports.console },
  };

  if (wasm instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(wasm, imports);
  }

  return WebAssembly.instantiate(wasm, imports);
}
