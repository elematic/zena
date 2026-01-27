/**
 * Tests for two-phase interface registration.
 *
 * These tests verify that interface method types correctly resolve class types,
 * even when the interface is declared before the class. This was a bug where
 * interface method parameters would incorrectly map to i32 instead of the
 * correct class struct type.
 *
 * The fix splits interface registration into two phases:
 * 1. preRegisterInterface - reserves type indices
 * 2. defineInterfaceMethods - creates method types after classes are pre-registered
 */
import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Interface Type Registration', () => {
  test('interface method with class parameter declared after interface', async () => {
    // This test verifies that an interface method parameter correctly
    // resolves to a class type even when the class is declared after the interface.
    // Before the fix, class types weren't registered yet when the interface
    // method types were created, causing incorrect WASM types.
    const source = `
      interface Logger {
        log(message: Message): void;
      }

      class Message {
        text: String;
        #new(text: String) {
          this.text = text;
        }
      }

      class ConsoleLogger implements Logger {
        logged: i32 = 0;

        log(message: Message): void {
          this.logged = this.logged + 1;
        }
      }

      export let main = (): i32 => {
        let cl = new ConsoleLogger();
        let logger: Logger = cl;
        let msg = new Message('hello');
        logger.log(msg);
        return cl.logged;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('interface method returns class type declared after interface', async () => {
    // Verify return types also work correctly
    const source = `
      interface Factory {
        create(): Product;
      }

      class Product {
        value: i32;
        #new(value: i32) {
          this.value = value;
        }
      }

      class ProductFactory implements Factory {
        create(): Product {
          return new Product(42);
        }
      }

      export let main = (): i32 => {
        let factory: Factory = new ProductFactory();
        let product = factory.create();
        return product.value;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('interface with multiple methods referencing multiple classes', async () => {
    // Multiple class references in a single interface
    const source = `
      interface Service {
        process(req: Request): Response;
        validate(req: Request): boolean;
      }

      class Request {
        id: i32;
        #new(id: i32) {
          this.id = id;
        }
      }

      class Response {
        code: i32;
        #new(code: i32) {
          this.code = code;
        }
      }

      class MyService implements Service {
        process(req: Request): Response {
          return new Response(req.id * 2);
        }

        validate(req: Request): boolean {
          return req.id > 0;
        }
      }

      export let main = (): i32 => {
        let svc: Service = new MyService();
        let req = new Request(21);
        let resp = svc.process(req);
        return resp.code;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('interface inheritance with class parameters', async () => {
    // Child interface methods must also correctly resolve class types
    const source = `
      interface BaseHandler {
        handle(event: Event): i32;
      }

      interface SpecialHandler extends BaseHandler {
        handleSpecial(event: SpecialEvent): i32;
      }

      class Event {
        code: i32;
        #new(code: i32) {
          this.code = code;
        }
      }

      class SpecialEvent extends Event {
        bonus: i32;
        #new(code: i32, bonus: i32) {
          super(code);
          this.bonus = bonus;
        }
      }

      class MyHandler implements SpecialHandler {
        handle(event: Event): i32 {
          return event.code;
        }

        handleSpecial(event: SpecialEvent): i32 {
          return event.code + event.bonus;
        }
      }

      export let main = (): i32 => {
        let handler: SpecialHandler = new MyHandler();
        let evt = new SpecialEvent(10, 5);
        return handler.handleSpecial(evt);
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 15);
  });

  test('interface field with class type', async () => {
    // Interface fields (getter signature) should also resolve class types
    const source = `
      interface Container {
        item: Item;
      }

      class Item {
        value: i32;
        #new(value: i32) {
          this.value = value;
        }
      }

      class Box implements Container {
        item: Item;
        #new(item: Item) {
          this.item = item;
        }
      }

      export let main = (): i32 => {
        let box: Container = new Box(new Item(99));
        return box.item.value;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 99);
  });

  test('generic interface with class type argument', async () => {
    // Generic interfaces instantiated with class types
    const source = `
      interface Wrapper<T> {
        get(): T;
        set(value: T): void;
      }

      class Data {
        num: i32;
        #new(num: i32) {
          this.num = num;
        }
      }

      class DataWrapper implements Wrapper<Data> {
        data: Data;

        #new() {
          this.data = new Data(0);
        }

        get(): Data {
          return this.data;
        }

        set(value: Data): void {
          this.data = value;
        }
      }

      export let main = (): i32 => {
        let dw = new DataWrapper();
        let wrapper: Wrapper<Data> = dw;
        wrapper.set(new Data(123));
        return wrapper.get().num;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 123);
  });

  test('interface accessor with class type', async () => {
    // Interface accessor signatures should resolve class types
    const source = `
      interface Holder {
        content: Content { get; set; }
      }

      class Content {
        data: i32;
        #new(data: i32) {
          this.data = data;
        }
      }

      class ContentHolder implements Holder {
        #content: Content;

        #new() {
          this.#content = new Content(0);
        }

        content: Content {
          get { return this.#content; }
          set(v) { this.#content = v; }
        }
      }

      export let main = (): i32 => {
        let ch = new ContentHolder();
        let holder: Holder = ch;
        holder.content = new Content(77);
        return holder.content.data;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 77);
  });
});
