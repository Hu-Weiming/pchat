import { expect, it } from "vitest";
import { testRole, testSettings } from "../../../../packages/testing/src/index";
import { connectionReadiness } from "./view-model";

it("guides configuration when selected model credentials or a participant corpus are not ready", () => {
  expect(connectionReadiness(testSettings, [testRole], [], [])).toEqual({ ready: false, message: "请先配置本会话使用的模型连接。" });
  const model = { label: "Configured model", binding: testSettings.model, ready: true };
  expect(connectionReadiness(testSettings, [testRole], [model], [{ label: "Knowledge base", connectionId: testSettings.ragConnectionId, readyCorpusIds: [] }]))
    .toEqual({ ready: false, message: "所选人物的资料尚未准备就绪，请检查知识库绑定。" });
});
