import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Secrets stay in an ignored local file; explicit environment always takes precedence. */
export async function loadRuntimeSecrets(){
 if(process.env.UAI_VAULT_KEY)return;
 try{const value=(await readFile(process.env.UAI_VAULT_KEY_FILE??resolve('.data/vault-key'),'utf8')).trim();if(Buffer.from(value,'base64').length!==32)throw new Error('Invalid local vault key');process.env.UAI_VAULT_KEY=value}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
