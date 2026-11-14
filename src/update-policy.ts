import {Target, targetName} from './update-format';

// Pinning this public key, rather than an environment setting, keeps a substituted origin from becoming trusted.
export const LAUNCHER_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAS007dqkac8Tmb75dl8PkejOTeOREdBPEmyWo4tOQpbI=\n-----END PUBLIC KEY-----\n';
export type UpdatePolicy = {
  target:Target; launcher:string; assetOrigin:string; redirectOrigins:readonly string[]; publicKey:string; request:typeof fetch;
  metadataDeadline:number; payloadDeadline:number; payloadIdleDeadline:number;
};
// The resources argument is kept because the native update helper of older releases calls this signature.
export function createLauncherPolicy(_resources:string,launcher:string):UpdatePolicy{
  return {target:targetName(),launcher,assetOrigin:'https://github.com',redirectOrigins:['https://api.github.com','https://github.com','https://release-assets.githubusercontent.com','https://objects.githubusercontent.com'],publicKey:LAUNCHER_PUBLIC_KEY,request:fetch,metadataDeadline:20_000,payloadDeadline:30*60_000,payloadIdleDeadline:60_000};
}
