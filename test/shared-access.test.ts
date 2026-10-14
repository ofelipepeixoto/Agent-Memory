import { describe, expect, it } from "vitest";
import { authorizeBearer, validateAccessMode } from "../src/access-policy.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockSdk, mockKV } from "./helpers/mocks.js";

describe("explicit shared access policy", () => {
  it.each([undefined, "", "   ", "${AGENTMEMORY_SECRET}"])("refuses shared startup with unusable secret %s", secret => {
    expect(() => validateAccessMode("shared",secret)).toThrow();
    expect(authorizeBearer({},secret,"shared")?.status_code).toBe(503);
  });
  it("rejects invalid mode and keeps local behavior explicit", () => {
    expect(() => validateAccessMode("sharedd","fixture")).toThrow();
    expect(validateAccessMode(undefined)).toBe("local");
    expect(authorizeBearer({},undefined,"local")).toBeNull();
  });
  it("requires exact bearer credential", () => {
    for (const h of [{}, {authorization:"Bearer wrong"}, {authorization:["Bearer fixture"]}]) {
      expect(authorizeBearer(h,"fixture","shared")?.status_code).toBe(401);
    }
    expect(authorizeBearer({authorization:"Bearer fixture"},"fixture","shared")).toBeNull();
  });
  it("rejects REST and MCP registration before exposing handlers", () => {
    const sdk = mockSdk(), kv = mockKV();
    expect(() => registerApiTriggers(sdk as any, kv as any, undefined, undefined, undefined, "shared")).toThrow();
    expect(() => registerMcpEndpoints(sdk as any, kv as any, undefined, "shared")).toThrow();
    expect(sdk.registerTrigger).not.toHaveBeenCalled();
  });
  it("denies REST middleware, direct handler and MCP without auth", async () => {
    const sdk = mockSdk(), kv = mockKV();
    registerApiTriggers(sdk as any, kv as any,"fixture",undefined,undefined,"shared");
    registerMcpEndpoints(sdk as any,kv as any,"fixture","shared");
    expect(await sdk.trigger('middleware::api-auth',{request:{headers:{}}})).toMatchObject({action:'respond',response:{status_code:401}});
    expect(await sdk.trigger('api::config-flags',{headers:{}})).toMatchObject({status_code:401});
    expect(await sdk.trigger('mcp::tools::list',{headers:{}})).toMatchObject({status_code:401});
    expect(await sdk.trigger('mcp::tools::list',{headers:{authorization:'Bearer fixture'}})).toMatchObject({status_code:200});
  });
  it("every registered HTTP surface denies unauthenticated shared access except liveness", async () => {
    const sdk=mockSdk(),kv=mockKV();
    registerApiTriggers(sdk as any,kv as any,'fixture',undefined,undefined,'shared');
    registerMcpEndpoints(sdk as any,kv as any,'fixture','shared');
    const denied=[];
    for (const [trigger] of sdk.registerTrigger.mock.calls) {
      if (trigger.type !== 'http' || trigger.function_id === 'api::liveness') continue;
      if (trigger.config?.middleware_function_ids?.includes('middleware::api-auth') || trigger.middleware_function_ids?.includes('middleware::api-auth')) continue;
      try {
        const result=await sdk.trigger(trigger.function_id,{headers:{},query_params:{},body:{},path_params:{}}) as any;
        if(result?.status_code !== 401) denied.push(`${trigger.function_id}:${result?.status_code}`);
      } catch { denied.push(`${trigger.function_id}:threw`); }
    }
    expect(denied).toEqual([]);
  });

});
