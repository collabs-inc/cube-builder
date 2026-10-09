import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hasHostDependency} from './public-source.mjs';
test('host-boundary audit ignores provenance comments but rejects executable and type dependencies',()=>{
 assert.equal(hasHostDependency('/** Original used window.api and @cube/router */\nconst value=1;','sample.ts'),false);
 assert.equal(hasHostDependency('// Original used window.api and @cube/router\nconst value=1;','sample.ts'),false);
 for(const source of ['window.api.ptyCreate()', 'window["api"].ptyCreate()', 'import type {Client} from "@cube/router"', 'process.env.CUBE_TOKEN', 'process.env["CUBED_SOCKET"]'])assert.equal(hasHostDependency(source,'sample.ts'),true,source);
 assert.equal(hasHostDependency('window /* deliberate gap */ . api.ptyCreate()','sample.ts'),true);
 assert.equal(hasHostDependency('const view=<div>{window.api.read()}</div>;','sample.tsx'),true);
});
