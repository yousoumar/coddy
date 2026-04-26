const readline = require("readline");
const path = require("path");
const fs = require("fs");

const YOU_COLOR = "\x1b[96m";
const ASSISTANT_COLOR = "\x1b[92m";
const TOOL_COLOR = "\x1b[95m";
const ERROR_COLOR = "\x1b[91m";
const RESET_COLOR = "\x1b[0m";

const SYSTEM_PROMPT = `
You are a coding assistant whose goal is to help us solve programming tasks. You have access to a series of tools that you can execute. Here are the tools you can execute:

{tools}

When you want to use a tool, respond with exactly one line in the format: 'tool: TOOL_NAME({{JSON_ARGS}})' and nothing else. Use a compact single-line JSON with double quotes. After receiving a tool_result(...) message, continue the task. If no tool is needed, respond normally.
`;

function resolveAbsPath(pathStr) {
  let resolvedPath = pathStr;
  if (resolvedPath.startsWith("~")) {
    resolvedPath = path.join(process.env.HOME || process.env.USERPROFILE, resolvedPath.slice(1));
  }
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.resolve(process.cwd(), resolvedPath);
  }
  return resolvedPath;
}

function readFileTool(args) {
  const filename = args.filename || ".";
  const fullPath = resolveAbsPath(filename);
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    return {
      file_path: fullPath,
      content: content,
    };
  } catch (err) {
    return {
      file_path: fullPath,
      error: err.message,
    };
  }
}

function listFilesTool(args) {
  const pathStr = args.path || ".";
  const fullPath = resolveAbsPath(pathStr);
  try {
    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    const allFiles = items.map((item) => ({
      filename: item.name,
      type: item.isFile() ? "file" : "dir",
    }));
    return {
      path: fullPath,
      files: allFiles,
    };
  } catch (err) {
    return {
      path: fullPath,
      error: err.message,
    };
  }
}

function editFileTool(args) {
  const pathStr = args.path || ".";
  const oldStr = args.old_str || "";
  const newStr = args.new_str || "";
  const fullPath = resolveAbsPath(pathStr);

  try {
    if (oldStr === "") {
      fs.writeFileSync(fullPath, newStr, "utf8");
      return {
        path: fullPath,
        action: "file_created",
      };
    }

    if (!fs.existsSync(fullPath)) {
      return {
        path: fullPath,
        action: "file_not_found",
      };
    }

    const original = fs.readFileSync(fullPath, "utf8");
    if (original.indexOf(oldStr) === -1) {
      return {
        path: fullPath,
        action: "old_str_not_found",
      };
    }

    const edited = original.replace(oldStr, newStr);
    fs.writeFileSync(fullPath, edited, "utf8");
    return {
      path: fullPath,
      action: "modified",
    };
  } catch (err) {
    return {
      path: fullPath,
      error: err.message,
    };
  }
}

const TOOL_REGISTRY = {
  read_file: readFileTool,
  list_files: listFilesTool,
  edit_file: editFileTool,
};

function getToolStrRepresentation(toolName) {
  if (toolName === "read_file") {
    return `
    Name: read_file
    Description: Gets the full content of a file provided by the user.
    Signature: (filename: str)
    `;
  } else if (toolName === "list_files") {
    return `
    Name: list_files
    Description: Lists files in a directory provided by the user.
    Signature: (path: str)
    `;
  } else if (toolName === "edit_file") {
    return `
    Name: edit_file
    Description: Replaces the first occurrence of old_str with new_str in the file. If old_str is empty, creates/overwrites the file with new_str.
    Signature: (path: str, old_str: str, new_str: str)
    `;
  }
  return "";
}

function getFullSystemPrompt() {
  let toolStrRepr = "";
  for (const toolName in TOOL_REGISTRY) {
    toolStrRepr += "TOOL\n===" + getToolStrRepresentation(toolName);
    toolStrRepr += `\n${"=".repeat(15)}\n`;
  }
  return SYSTEM_PROMPT.replace("{tools}", toolStrRepr);
}

function extractToolInvocations(text) {
  const invocations = [];
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("tool:")) {
      continue;
    }
    try {
      const after = line.slice("tool:".length).trim();
      const firstParenIndex = after.indexOf("(");
      if (firstParenIndex === -1) continue;

      const name = after.slice(0, firstParenIndex).trim();
      const rest = after.slice(firstParenIndex + 1);

      if (!rest.endsWith(")")) {
        continue;
      }
      const jsonStr = rest.slice(0, -1).trim();
      const args = JSON.parse(jsonStr);
      invocations.push([name, args]);
    } catch (err) {
      continue;
    }
  }
  return invocations;
}

async function executeLlmCall(conversation) {
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_KEY}`,
        },
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          messages: conversation,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API Error: ${response.status} ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();

    return data.choices[0].message.content;
  } catch (err) {
    console.error("Error during LLM API call:", err);
    throw err;
  }
}

async function runCodingAgentLoop() {
  if (!process.env.API_KEY) {
    console.error("Error: API_KEY environment variable is not defined.");
    process.exit(1);
  }

  console.log(`
${ASSISTANT_COLOR}
  ____          _     _       
 / ___|___   __| | __| |_   _ 
| |   / _ \\ / _\` |/ _\` | | | |
| |__| (_) | (_| | (_| | |_| |
 \\____\\___/ \\__,_|\\__,_|\\__, |
                        |___/ 
${RESET_COLOR}
${YOU_COLOR}Coddy - Your AI Coding Assistant${RESET_COLOR}
I can help you explore, read, and edit your codebase.
Type your instructions below to get started.
  `);

  const systemPrompt = getFullSystemPrompt();

  const conversation = [
    {
      role: "system",
      content: systemPrompt,
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });

  const promptUser = () => {
    return new Promise((resolve) => {
      rl.question(`${YOU_COLOR}> ${RESET_COLOR}`, (answer) => {
        resolve(answer);
      });
    });
  };

  while (true) {
    let userInput;
    try {
      userInput = await promptUser();
    } catch (e) {
      break;
    }

    if (userInput === null || userInput === undefined) {
      break;
    }

    conversation.push({
      role: "user",
      content: userInput.trim(),
    });

    while (true) {
      try {
        const assistantResponse = await executeLlmCall(conversation);
        const toolInvocations = extractToolInvocations(assistantResponse);

        conversation.push({
          role: "assistant",
          content: assistantResponse,
        });

        if (toolInvocations.length === 0) {
          console.log(`${ASSISTANT_COLOR}Assistant:${RESET_COLOR} ${assistantResponse}`);
          break;
        }

        console.log(`${ASSISTANT_COLOR}Model requested tool execution.${RESET_COLOR}`);
        for (const [name, args] of toolInvocations) {
          console.log(`- Executing tool: ${TOOL_COLOR}${name}${RESET_COLOR} with args:`, args);
          const tool = TOOL_REGISTRY[name];
          let resp = "";
          if (tool) {
            resp = tool(args);
          } else {
            resp = { error: `Tool ${name} not found` };
          }
          console.log(`- Tool ${TOOL_COLOR}${name}${RESET_COLOR} returned result.`);

          conversation.push({
            role: "user",
            content: `tool_result(${JSON.stringify(resp)})`,
          });
        }
      } catch (err) {
        console.error(`${ERROR_COLOR}Error:${RESET_COLOR} ${err.message}`);
        break;
      }
    }
  }
}

runCodingAgentLoop();
