import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {generateKeyPairSync,sign} from 'node:crypto';
import {newestServer,authenticateServer,SERVER_DOMAIN,serverAssetURL} from '../dist/server-updates.js';
test('the newest of the bundled and downloaded servers runs',async()=>{const storage=await mkdtemp(join(tmpdir(),'servers-'));assert.deepEqual(await newestServer('/bundled','1.0.5',storage),{version:'1.0.5',root:'/bundled'});
 for(const name of ['1.0.4','1.0.7','.staging-x','junk'])await mkdir(join(storage,'servers',name),{recursive:true});
 assert.deepEqual(await newestServer('/bundled','1.0.5',storage),{version:'1.0.7',root:join(storage,'servers','1.0.7')});assert.deepEqual(await newestServer('/bundled','1.0.8',storage),{version:'1.0.8',root:'/bundled'});});
test('server manifests need the server signature domain and exact release URL',()=>{const {privateKey,publicKey}=generateKeyPairSync('ed25519'),key=publicKey.export({format:'pem',type:'spki'});
 const name='server-linux-x64.tar.gz',bytes=Buffer.from(JSON.stringify({format:1,kind:'openrotmg-server',version:'1.0.6',target:'linux-x64',minLauncher:'1.0.5',payload:{name,url:serverAssetURL('1.0.6',name),bytes:5,sha256:'a'.repeat(64)}}));
 assert.equal(authenticateServer(bytes,sign(null,Buffer.concat([SERVER_DOMAIN,bytes]),privateKey),key,'linux-x64').version,'1.0.6');
 assert.throws(()=>authenticateServer(bytes,sign(null,bytes,privateKey),key,'linux-x64'),/signature/);assert.throws(()=>authenticateServer(bytes,sign(null,Buffer.concat([SERVER_DOMAIN,bytes]),privateKey),key,'win32-x64'),/Invalid server manifest/);});
