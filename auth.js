let authClient;

async function getAuthClient() {
  if (authClient) return authClient;

  const response = await fetch('/api/auth/config');
  const config = await response.json();

  if (!response.ok) {
    throw new Error(config.error || 'Authentication is not configured.');
  }

  authClient = window.supabase.createClient(config.url, config.anonKey);
  return authClient;
}

async function getAccessToken() {
  const client = await getAuthClient();
  const { data } = await client.auth.getSession();
  return data.session ? data.session.access_token : null;
}
