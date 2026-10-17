/**
 * Minimal YAML emitter — enough for the shapes promptfoo configs use
 * (maps, sequences, nested maps inside sequences) and nothing more.
 *
 * Strings are emitted as JSON double-quoted scalars: JSON's escape set is a
 * subset of YAML's double-quoted style, so the result always parses.
 */

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (item === null || typeof item !== 'object') return `${pad}- ${scalar(item)}`;
        // The nested map is already rendered at indent + 2, so only its first
        // line needs the `- ` marker; the rest keep their own indentation.
        const [first, ...rest] = toYaml(item, indent + 2).split('\n');
        return [`${pad}- ${first.trimStart()}`, ...rest].join('\n');
      })
      .join('\n');
  }

  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (keys.length === 0) return `${pad}{}`;
    return keys
      .map((key) => {
        const v = value[key];
        if (v !== null && typeof v === 'object') {
          const inline = Array.isArray(v) && v.length === 0 ? ' []' : '';
          return `${pad}${key}:${inline}\n${toYaml(v, indent + 2)}`;
        }
        return `${pad}${key}: ${scalar(v)}`;
      })
      .join('\n');
  }

  return `${pad}${scalar(value)}`;
}

module.exports = { toYaml };
