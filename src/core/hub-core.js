/**
 * Tiny page-type registry. This is the ONLY shared piece of the page templates,
 * and it contains no page content — just a lookup table. You should almost never
 * need to edit this file.
 */
const HubRegistry = (function () {
  const types = new Map();
  return {
    register(meta, generator) { types.set(meta.key, { meta, generator }); },
    generate(typeKey, inputs) {
      const entry = types.get(typeKey);
      if (!entry) throw new Error('Unknown hub type: ' + typeKey);
      return entry.generator(inputs);
    },
    list() { return [...types.values()].map(t => t.meta); },
  };
})();
const HUB_TYPES = HubRegistry.list.bind(HubRegistry);
