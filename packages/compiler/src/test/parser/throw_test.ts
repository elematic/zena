import {Parser} from '../../lib/parser.js';
import {test} from 'node:test';

test('throw expression', () => {
  const parser = new Parser('throw new Error("fail");');
  parser.parse();
  // Check AST structure if needed, or just that it parses
  console.log('Parsed successfully');
});

test('throw in expression', () => {
  const parser = new Parser('let x = 1 + throw new Error("fail");');
  parser.parse();
  console.log('Parsed successfully');
});
