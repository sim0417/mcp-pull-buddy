import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runTest = async () => {
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["dev"],
  });

  const client = new Client(
    {
      name: "test-client",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {}, // 도구 사용 기능 활성화
      },
    }
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    console.log("사용 가능한 도구:", tools);

    const result = await client.callTool({
      name: "hello world",
      arguments: {
        message: "MCP",
      },
    });

    console.log("call hello world tool result:", result);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    console.log("end test");
    await client.close();
  }
};

runTest();
