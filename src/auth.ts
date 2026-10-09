import 'dotenv/config';
import { promises as fs } from 'node:fs';
import {
  PublicClientApplication,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';

const CACHE_FILE = '.token-cache.json';

const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    try {
      ctx.tokenCache.deserialize(await fs.readFile(CACHE_FILE, 'utf8'));
    } catch {
      /* premier lancement : pas de cache */
    }
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (ctx.cacheHasChanged) {
      await fs.writeFile(CACHE_FILE, ctx.tokenCache.serialize(), { mode: 0o600 });
    }
  },
};

const pca = new PublicClientApplication({
  auth: {
    clientId: process.env.CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
  },
  cache: { cachePlugin },
});

const scopes = ['User.Read', 'Mail.ReadWrite'];

export async function getToken(): Promise<string> {
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const silent = await pca.acquireTokenSilent({ account: accounts[0], scopes });
      return silent.accessToken;
    } catch {
      /* jeton expiré ou révoqué : on redemande une connexion */
    }
  }
  const result = await pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (d) => console.log(d.message),
  });
  if (!result) throw new Error('Authentification échouée');
  return result.accessToken;
}