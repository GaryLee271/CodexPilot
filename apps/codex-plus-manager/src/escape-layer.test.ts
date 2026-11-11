import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { escapeLayerCount, handleEscapeKey, pushEscapeLayer, resetEscapeLayers } from "./escape-layer.ts";

/** 模拟一次按键：记下有没有被吞掉。 */
function press(key: string, extra: { isComposing?: boolean } = {}) {
  const event = {
    key,
    ...extra,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
  const handled = handleEscapeKey(event);
  return { handled, prevented: event.prevented, stopped: event.stopped };
}

describe("Esc 栈：一次 Esc 只关最上面那层", () => {
  beforeEach(() => resetEscapeLayers());

  it("外层弹窗 + 内层下拉：第一次 Esc 只关下拉，第二次才关弹窗", () => {
    const closed: string[] = [];
    const releaseDialog = pushEscapeLayer(() => closed.push("dialog"));
    const releaseSelect = pushEscapeLayer(() => {
      closed.push("select");
      releaseSelect();
    });
    const first = press("Escape");
    assert.deepEqual(closed, ["select"]);
    assert.equal(first.handled, true);
    assert.equal(first.prevented, true);
    assert.equal(first.stopped, true, "吞掉这次按键，其它监听（如管理页抽屉）收不到");
    press("Escape");
    assert.deepEqual(closed, ["select", "dialog"]);
    releaseDialog();
    assert.equal(escapeLayerCount(), 0);
  });

  it("三层（添加流程 → 导入 → 确认框）逐层关闭", () => {
    const closed: string[] = [];
    const layers = ["catalog", "import", "confirm"].map((name) => {
      const release = pushEscapeLayer(() => {
        closed.push(name);
        release();
      });
      return release;
    });
    press("Escape");
    press("Escape");
    press("Escape");
    assert.deepEqual(closed, ["confirm", "import", "catalog"]);
    assert.equal(layers.length, 3);
    assert.equal(escapeLayerCount(), 0);
  });

  it("没有弹层、不是 Esc、输入法组字时都不处理也不吞掉", () => {
    assert.deepEqual(press("Escape"), { handled: false, prevented: false, stopped: false });
    let closed = 0;
    pushEscapeLayer(() => {
      closed += 1;
    });
    assert.equal(press("Enter").handled, false);
    assert.equal(press("Escape", { isComposing: true }).handled, false);
    assert.equal(closed, 0);
  });

  it("注销中间一层不影响顺序；重复注销没有副作用", () => {
    const closed: string[] = [];
    pushEscapeLayer(() => closed.push("a"));
    const releaseB = pushEscapeLayer(() => closed.push("b"));
    pushEscapeLayer(() => closed.push("c"));
    releaseB();
    releaseB();
    assert.equal(escapeLayerCount(), 2);
    press("Escape");
    assert.deepEqual(closed, ["c"]);
  });
});

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
