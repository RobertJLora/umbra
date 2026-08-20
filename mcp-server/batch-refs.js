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
    // The bare-string shorthand runs over every string in every child's params,
    // so ordinary data shaped like a reference used to fail the whole batch:
    // a currency amount, a password, a jQuery-style identifier. An unresolvable
    // shorthand is treated as the literal the caller wrote, which is how the
    // same value already behaves outside a batch. The documented object form,
    // {"$ref": "..."}, still fails loudly, because there it is unambiguous.
    try {
      return resolveBatchRef(value, results);
    } catch {
      return value;
    }
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

// resolveBatchParams hands back the referenced value itself when a child's whole
// params object is a single {"$ref": ...}. Mutating that object writes into the
// result an earlier step already reported, so the batch report shows a timeoutMs
// the extension never returned. One shallow copy removes the aliasing.
export function copyResolvedParams(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value };
  }
  return value;
}
