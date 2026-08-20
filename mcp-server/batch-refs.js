function valueAtPath(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function resultForRefHead(results, head) {
  if (head === 'prev') {
    return [...results].reverse().find((result) => result.ok)?.result;
  }
  if (/^\d+$/.test(head)) {
    return results[Number(head)]?.result;
  }
  return results.find((result) => result.label === head)?.result;
}

function resolveBatchRef(ref, results) {
  const cleanRef = String(ref || '').replace(/^\$/, '');
  const [head, ...pathParts] = cleanRef.split('.').filter(Boolean);
  if (!head) {
    throw new Error('Batch reference cannot be empty.');
  }
  const source = resultForRefHead(results, head);
  const resolved = valueAtPath(source, pathParts);
  if (resolved === undefined) {
    throw new Error(`Could not resolve browser_batch reference: ${ref}`);
  }
  return resolved;
}

export function resolveBatchParams(value, results) {
  if (typeof value === 'string' && /^\$(prev|\d+|[a-zA-Z][\w-]*)(\.|$)/.test(value)) {
    return resolveBatchRef(value, results);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveBatchParams(item, results));
  }
  if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
    return resolveBatchRef(value.$ref, results);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveBatchParams(item, results)]),
  );
}
