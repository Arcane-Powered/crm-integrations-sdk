export interface AuthResult {
  headers: Record<string, string>;
  secretValues: string[];
}

function base64Utf8(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const auth = {
  none: (): AuthResult => ({ headers: {}, secretValues: [] }),
  basic: (username: string, password: string): AuthResult => {
    const pair = `${username}:${password}`;
    const encoded = base64Utf8(pair);
    return { headers: { Authorization: `Basic ${encoded}` }, secretValues: [pair, encoded] };
  },
  bearer: (token: string): AuthResult => ({ headers: { Authorization: `Bearer ${token}` }, secretValues: [token] }),
  header: (name: string, value: string): AuthResult => ({ headers: { [name]: value }, secretValues: [value] }),
  headers: (headers: Record<string, string>): AuthResult => ({ headers: { ...headers }, secretValues: Object.values(headers) }),
};
