import {suite, test} from 'node:test';
import assert from 'node:assert';
import {ZenaProject} from '../lib/zena-project.js';

suite('ZenaProject file management', () => {
  test('initializes with default file if none provided', () => {
    const project = new ZenaProject();
    assert.strictEqual(project.activeFile, 'main.zena');
  });

  test('manages custom files via setFiles / files setter', () => {
    const project = new ZenaProject();
    project.files = {
      'main.zena': 'let x = 1;',
      'helper.zena': 'let y = 2;',
    };

    assert.strictEqual(project.files.length, 2);
    assert.strictEqual(project.getAllFiles()['main.zena'], 'let x = 1;');
    assert.strictEqual(project.getAllFiles()['helper.zena'], 'let y = 2;');
  });

  test('adds new file and selects it', () => {
    const project = new ZenaProject();
    project.files = {'main.zena': 'let x = 1;'};

    const added = project.addFile();
    assert.strictEqual(added, 'module.zena');
    assert.strictEqual(project.activeFile, 'module.zena');
    assert.strictEqual(project.files.length, 2);

    const added2 = project.addFile();
    assert.strictEqual(added2, 'module_1.zena');
    assert.strictEqual(project.activeFile, 'module_1.zena');
    assert.strictEqual(project.files.length, 3);
  });

  test('renames existing file', () => {
    const project = new ZenaProject();
    project.files = {
      'main.zena': 'let x = 1;',
      'old.zena': 'let old = true;',
    };

    const renamed = project.renameFile('old.zena', 'new.zena');
    assert.strictEqual(renamed, true);
    assert.strictEqual(project.getAllFiles()['old.zena'], undefined);
    assert.strictEqual(project.getAllFiles()['new.zena'], 'let old = true;');
  });

  test('deletes file and falls back to remaining file', () => {
    const project = new ZenaProject();
    project.files = {
      'main.zena': 'let x = 1;',
      'temp.zena': 'let temp = 0;',
    };
    project.selectFile('temp.zena');
    assert.strictEqual(project.activeFile, 'temp.zena');

    const deleted = project.deleteFile('temp.zena');
    assert.strictEqual(deleted, true);
    assert.strictEqual(project.files.length, 1);
    assert.strictEqual(project.activeFile, 'main.zena');
  });

  test('filters diagnostics by filename', () => {
    const project = new ZenaProject();
    project.diagnostics = [
      {
        file: 'main.zena',
        line: 1,
        column: 1,
        length: 5,
        severity: 'error',
        message: 'Main error',
      },
      {
        file: './math.zena',
        line: 2,
        column: 3,
        length: 4,
        severity: 'warning',
        message: 'Math warning',
      },
    ];

    const mainDiags = project.getFileDiagnostics('main.zena');
    assert.strictEqual(mainDiags.length, 1);
    assert.strictEqual(mainDiags[0].message, 'Main error');

    const mathDiags = project.getFileDiagnostics('math.zena');
    assert.strictEqual(mathDiags.length, 1);
    assert.strictEqual(mathDiags[0].message, 'Math warning');
  });
});
