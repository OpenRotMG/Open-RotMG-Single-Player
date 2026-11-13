import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {decodeJson, exact, hex, MAX_METADATA, REPOSITORY, Target, targetName, verifyManifest} from './update-format';

// Pinning this public key, rather than an environment setting, keeps a substituted origin from becoming trusted.
export const MANIFEST_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAS007dqkac8Tmb75dl8PkejOTeOREdBPEmyWo4tOQpbI=\n-----END PUBLIC KEY-----\n';
export const LAUNCHER_PUBLIC_KEY = MANIFEST_PUBLIC_KEY;
export function createLauncherPolicy(resources:string,launcher:string):UpdatePolicy{return {...createUpdatePolicy(resources,launcher),publicKey:LAUNCHER_PUBLIC_KEY};}
export type Baseline = {root:string; mode:'source'|'release'; identitySha256:string; startupBackup:0|1; clientNamespace:0|1; manifest?:Uint8Array; signature?:Uint8Array};
export type UpdatePolicy = {
  target:Target; launcher:string; baseline:Baseline; metadataBundle:{baseline:Baseline;publicKey:string;assetOrigin:string}; discovery:string; assetOrigin:string;
  redirectOrigins:readonly string[]; publicKey:string; request:typeof fetch;
  metadataDeadline:number; payloadDeadline:number; payloadIdleDeadline:number;
};
export function createUpdatePolicy(resources:string, launcher:string):UpdatePolicy {
  const config=decodeJson(readFileSync(join(__dirname,'runtime-baseline.json')),MAX_METADATA*2+1024);
  if(config&&typeof config==='object'&&!Array.isArray(config)&&(config as {mode?:unknown}).mode==='release'){
    exact(config,'format,mode,identitySha256,startupBackup,clientNamespace,manifest,signature','release baseline');
    if(config.format!==1||config.startupBackup!==1||config.clientNamespace!==1||!hex(config.identitySha256)||typeof config.manifest!=='string'||typeof config.signature!=='string')throw Error('Invalid release baseline configuration');
    const manifest=Buffer.from(config.manifest,'base64'),signature=Buffer.from(config.signature,'base64');
    if(manifest.toString('base64')!==config.manifest||signature.toString('base64')!==config.signature)throw Error('Noncanonical embedded manifest/signature encoding');
    verifyManifest(manifest,signature,MANIFEST_PUBLIC_KEY,undefined,undefined,targetName(),launcher,'https://github.com');
    return policy(launcher,{root:join(resources,'runtime'),mode:'release',identitySha256:config.identitySha256,startupBackup:1,clientNamespace:1,manifest,signature});
  }
  exact(config,'format,mode,identitySha256,startupBackup,clientNamespace','source baseline');
  if(config.format!==1||config.mode!=='source'||![0,1].includes(Number(config.startupBackup))||typeof config.startupBackup!=='number'||![0,1].includes(Number(config.clientNamespace))||typeof config.clientNamespace!=='number'||!hex(config.identitySha256))throw Error('Invalid source baseline configuration; no release fallback is allowed');
  return policy(launcher,{root:join(resources,'runtime'),mode:'source',identitySha256:config.identitySha256,startupBackup:config.startupBackup as 0|1,clientNamespace:config.clientNamespace as 0|1});
}
function policy(launcher:string,baseline:Baseline):UpdatePolicy {
  return {target:targetName(),launcher,baseline,metadataBundle:{baseline,publicKey:MANIFEST_PUBLIC_KEY,assetOrigin:'https://github.com'},discovery:`https://api.github.com/repos/${REPOSITORY}/releases/latest`,assetOrigin:'https://github.com',redirectOrigins:['https://api.github.com','https://github.com','https://release-assets.githubusercontent.com','https://objects.githubusercontent.com'],publicKey:MANIFEST_PUBLIC_KEY,request:fetch,metadataDeadline:20_000,payloadDeadline:30*60_000,payloadIdleDeadline:60_000};
}
