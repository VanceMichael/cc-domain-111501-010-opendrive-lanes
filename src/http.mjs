export async function request(base, path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options, signal: options.signal ?? AbortSignal.timeout(3000), redirect: 'manual'
  });
  return response;
}

export async function json(base, path, options = {}) {
  const response = await request(base, path, options);
  if (!response.ok) {
    const error = new Error(`source status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function text(base, path, options = {}) {
  const response = await request(base, path, options);
  if (!response.ok) throw new Error(`source status ${response.status}`);
  return response.text();
}
