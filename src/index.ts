import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const initServer = async () => {
  const server = new McpServer({
    name: "mcp-pull-buddy",
    version: "0.1.0",
  });

  server.tool("hello world", { message: z.string() }, async ({ message }) => {
    return {
      content: [
        {
          type: "text",
          text: `Hello ${message}`,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
};

const runServer = async () => {
  try {
    const server = await initServer();
    console.log("Server is running");
  } catch (error) {
    console.error(`Run server error: ${error}`);
  }
};

runServer();
