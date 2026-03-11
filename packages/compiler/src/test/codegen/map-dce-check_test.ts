import {test} from 'node:test';
import {compileAndRun} from './utils.js';

test.only('map literal with DCE', async () => {
  const source = `
    import {Map} from 'zena:map';
    export let main = () => {
      let m = {"a" => 1, "b" => 2};
      let (v, _) = m.get("a");
      return v;
    };
  `;
  const result = await compileAndRun(source);
  console.log('Result:', result);
});
