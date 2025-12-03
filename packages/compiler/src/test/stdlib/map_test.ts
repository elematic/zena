
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

suite('Map Tests', () => {
  test('Map operations', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../test-files/map_test.zena'),
      'utf-8',
    );
    
    // Capture console output
    let output = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += msg + '\n';
    };

    try {
      await compileAndRun(source, 'main');
    } finally {
      console.log = originalLog;
    }

    assert.match(output, /one: 1/);
    assert.match(output, /two: 2/);
    assert.match(output, /size: 2/);
    assert.match(output, /has one: true/);
    assert.match(output, /has three: false/);
    assert.match(output, /size after delete: 1/);
    assert.match(output, /has one after delete: false/);
    
    assert.match(output, /p1: Point 1/);
    assert.match(output, /p2: Point 2/);
    assert.match(output, /p3 \(equal to p1\): Point 1/);
  });
});
