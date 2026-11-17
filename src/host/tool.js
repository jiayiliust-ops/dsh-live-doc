/**
 * Tool definition compiler.
 *
 * DSH's own `defineTool` lives in `@deepseek-ai/dsh-tools`, a package that is
 * resolved from the Harness installation. A plugin shipped as a tarball or npm
 * package gets the same tool shape only if that package is resolvable from the
 * profile — and a plugin that also wants to run from a plain checkout does not
 * get that guarantee. The registry itself only needs the compiled definition
 * (`name`, `description`, JSON-Schema `parameters`, `output.schema/render`,
 * `execute`), so this module compiles the small parameter DSL with the same
 * rules the official helper uses:
 *
 *   { title: { type: 'string', description: '...', required: true } }
 *   -> { type: 'object', properties: {...}, required: ['title'] }
 *
 * Keeping it here makes the Host half dependency-free, which is what lets the
 * plugin be installed from a GitHub checkout, an npm tarball, or a linked
 * directory without a build step.
 *
 * @module dsh-live-doc/tool
 */

/**
 * Compile the per-property parameter DSL into a JSON Schema object.
 * @param {Record<string, { type: string, description?: string, required?: boolean, enum?: unknown[], items?: object }>} spec
 * @returns {object} JSON Schema accepted by the tool registry.
 */
export function compileParameters(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    const property = { type: value.type };
    if (value.description !== undefined) property.description = value.description;
    if (value.enum !== undefined) property.enum = value.enum;
    if (value.items !== undefined) property.items = value.items;
    properties[key] = property;
    if (value.required === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Build a registry-ready tool definition.
 * @param {{ name: string, description: string, parameters?: object, output: { schema: object, render: Function }, execute: Function }} options
 * @returns {object} the object passed to `ctx.tools.register`.
 */
export function defineTool(options) {
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new TypeError('defineTool: name is required');
  }
  if (options.output === undefined || typeof options.output.render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output.render is required`);
  }
  if (options.output.schema === undefined) {
    throw new TypeError(`defineTool(${options.name}): output.schema is required`);
  }
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters),
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    execute: options.execute,
  };
}
