import {Parser} from '../../lib/parser.js';
import {test} from 'node:test';

test('unary minus', () => {
  const parser = new Parser('let x = -1;');
  try {
    parser.parse();
    console.log('Parsed successfully');
  } catch (e: any) {
    console.log('Parse failed:', e.message);
  }
});
