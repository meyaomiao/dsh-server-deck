import { test } from 'node:test';
import assert from 'node:assert/strict';

const STYLE_ID = 'server-deck-styles';
const OWNER = 'dsh-server-deck';
const CSS_ID = 'dsh-server-deck/styles';

class StyleTag {
  id = '';
  textContent = '';
  private attributes = new Map<string, string>();

  constructor(private tags: StyleTag[]) {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  remove(): void {
    this.tags.splice(this.tags.indexOf(this), 1);
  }
}

async function fixture() {
  const tags: StyleTag[] = [];
  const insertedOwners: (string | null)[] = [];
  const document = {
    head: {
      appendChild(style: StyleTag) {
        insertedOwners.push(style.getAttribute('data-plugin'));
        tags.push(style);
        return style;
      },
    },
    getElementById(id: string) {
      return tags.find((style) => style.id === id) ?? null;
    },
    createElement(name: string) {
      assert.equal(name, 'style');
      return new StyleTag(tags);
    },
    querySelectorAll(selector: string) {
      assert.equal(selector, 'style');
      return tags;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  const { ensureStyles } = await import(`../src/client/styles.ts?fixture=${Math.random()}`);

  // Same ownership rules as DSH ModuleLoader: claim unowned tags, prune only an owner's tags.
  const claimStyles = (owner: string) => {
    for (const style of document.querySelectorAll('style')) {
      if (!style.getAttribute('data-plugin')) style.setAttribute('data-plugin', owner);
    }
  };
  const removeOwnedStyles = (owner: string) => {
    for (const style of [...document.querySelectorAll('style')]) {
      if (style.getAttribute('data-plugin') === owner) style.remove();
    }
  };
  return {
    document, tags, insertedOwners, ensureStyles, claimStyles, removeOwnedStyles,
    restore() {
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    },
  };
}

test('styles belong to Server Deck before insertion and survive unrelated client HMR', async () => {
  const f = await fixture();
  try {
    f.claimStyles(OWNER); // Server Deck materializes before apply() inserts its styles.
    f.ensureStyles();
    const style = f.document.getElementById(STYLE_ID)!;
    f.claimStyles('another-client');
    f.removeOwnedStyles('another-client');
    assert.equal(f.document.getElementById(STYLE_ID), style, 'unrelated HMR must not prune Deck styles');
    assert.deepEqual(f.insertedOwners, [OWNER], 'style must already be owned when attached');
    assert.equal(style.getAttribute('data-plugin-css'), CSS_ID);
    assert.match(style.textContent, /\.sd-card/);
    assert.match(style.textContent, /\.xterm/);
  } finally {
    f.restore();
  }
});

test('ensureStyles repairs legacy ownership and CSS identity without duplicating the tag', async () => {
  const f = await fixture();
  try {
    const legacy = f.document.createElement('style');
    legacy.id = STYLE_ID;
    legacy.setAttribute('data-plugin', 'another-client');
    legacy.setAttribute('data-plugin-css', 'legacy-css');
    f.document.head.appendChild(legacy);
    f.ensureStyles();
    f.ensureStyles();
    f.removeOwnedStyles('another-client');
    assert.equal(f.document.getElementById(STYLE_ID), legacy);
    assert.equal(legacy.getAttribute('data-plugin'), OWNER);
    assert.equal(legacy.getAttribute('data-plugin-css'), CSS_ID);
    assert.equal(f.tags.length, 1);
  } finally {
    f.restore();
  }
});

test('ensureStyles recreates removed styles in the same module and remains idempotent', async () => {
  const f = await fixture();
  try {
    f.ensureStyles();
    const original = f.document.getElementById(STYLE_ID)!;
    original.remove();
    f.ensureStyles();
    const replacement = f.document.getElementById(STYLE_ID);
    assert.ok(replacement, 'a deleted style must be recreated without reloading the module');
    assert.notEqual(replacement, original);
    f.ensureStyles();
    f.removeOwnedStyles(OWNER);
    assert.equal(f.tags.length, 0);
    f.ensureStyles();
    f.ensureStyles();
    assert.equal(f.tags.length, 1);
    assert.equal(f.tags[0].getAttribute('data-plugin'), OWNER);
    assert.equal(f.tags[0].getAttribute('data-plugin-css'), CSS_ID);
  } finally {
    f.restore();
  }
});
