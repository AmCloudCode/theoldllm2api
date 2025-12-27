// 配置常量
const UPSTREAM_ORIGIN = "https://theoldllm.vercel.app";
const DEFAULT_MODEL = "ent-claude-opus-4.5-20251101";

// 硬编码的默认 Token (来自你的 curl)
const FALLBACK_TOKEN = "Bearer ";

const ALLOWED_MODELS = [
  "ent-claude-opus-4.5-20251101",
  "ent-claude-opus-4.1"
];

// 伪装 Headers (严格复制自你的成功抓包)
const COMMON_HEADERS = {
  "authority": "theoldllm.vercel.app",
  "accept": "*/*",
  "accept-language": "zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "content-type": "application/json",
  "origin": "https://theoldllm.vercel.app",
  "referer": "https://theoldllm.vercel.app/",
  "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const method = req.method;

  // CORS 处理
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // 1. /v1/models 接口
  if (url.pathname === "/v1/models") {
    return new Response(
      JSON.stringify({
        object: "list",
        data: ALLOWED_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "openai-proxy",
        })),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // 2. /v1/chat/completions 接口
  if (url.pathname === "/v1/chat/completions" && method === "POST") {
    try {
      const body = await req.json();
      const isStream = body.stream || false;
      const model = body.model || DEFAULT_MODEL;

      // 鉴权
      let authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        authHeader = FALLBACK_TOKEN;
      }

      // --- 第一步：创建会话 (Create Chat Session) ---
      // 根据 Logs，必须先请求这个接口拿到 chat_session_id
      const createSessionResp = await fetch(`${UPSTREAM_ORIGIN}/entp/chat/create-chat-session`, {
        method: "POST",
        headers: {
          ...COMMON_HEADERS,
          "authorization": authHeader,
        },
        body: JSON.stringify({
          persona_id: 154, // 根据抓包数据硬编码
          description: "Streaming chat session using gpt-5.2" // 描述可以随意，保留抓包原样
        })
      });

      if (!createSessionResp.ok) {
        throw new Error(`Failed to create session: ${createSessionResp.statusText}`);
      }

      const sessionData = await createSessionResp.json();
      const chatSessionId = sessionData.chat_session_id;

      if (!chatSessionId) {
        throw new Error("Upstream did not return a chat_session_id");
      }

      // --- 第二步：转换消息并发送 (Send Message) ---
      const prompt = convertMessagesToPrompt(body.messages);

      const sendMsgResp = await fetch(`${UPSTREAM_ORIGIN}/entp/chat/send-message`, {
        method: "POST",
        headers: {
          ...COMMON_HEADERS,
          "authorization": authHeader,
        },
        body: JSON.stringify({
          chat_session_id: chatSessionId,
          parent_message_id: null, // 抓包显示为 null
          message: prompt,
          file_descriptors: [],
          search_doc_ids: [],
          retrieval_options: {}
        }),
      });

      if (!sendMsgResp.ok) {
         throw new Error(`Upstream error: ${sendMsgResp.statusText}`);
      }

      // --- 第三步：处理流式响应 ---
      const stream = sendMsgResp.body;
      if (!stream) throw new Error("No response body");

      const readable = new ReadableStream({
        async start(controller) {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          const chatId = `chatcmpl-${crypto.randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);
          
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;

              // 按行处理 buffer (上游是 NDJSON)
              const lines = buffer.split("\n");
              // 保留最后一行（可能不完整）
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;
                
                try {
                  // 解析上游 JSON: {"ind": 1, "obj": {"type": "message_delta", "content": "Hi"}}
                  const json = JSON.parse(line);
                  
                  if (json && json.obj) {
                    const type = json.obj.type;
                    const content = json.obj.content || "";

                    // 只需要处理 content delta
                    if (type === "message_delta" && content) {
                      if (isStream) {
                        const openaiChunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created: created,
                            model: model,
                            choices: [{ index: 0, delta: { content: content }, finish_reason: null }]
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                      } else {
                        // 如果不是流式，先不在这里处理，下面有非流式逻辑，
                        // 但为了统一代码结构，我们可以在这里通过 controller 传递
                        // 实际部署通常客户端都请求 stream=true。
                        // 简单起见，本代码强制以 stream 模式返回给客户端，或客户端需自行处理。
                        // 如果必须支持非 stream，需要在外面包一层 accumulator。
                      }
                    } else if (type === "stop" || type === "section_end") {
                        // 结束信号
                    }
                  }
                } catch (e) {
                  // 忽略 JSON 解析错误，继续下一行
                }
              }
            }
            
            // 结束
            if (isStream) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          } catch (err) {
            console.error("Stream error", err);
            controller.error(err);
          } finally {
            controller.close();
          }
        },
      });

      // 如果客户端请求 stream: true
      if (isStream) {
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } 
      
      // 如果客户端请求 stream: false (非流式)
      // 我们需要把 readable 读完拼接成一个 JSON
      else {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          // 这里的 text 是 "data: {...}" 格式，需要提取 content
          const lines = text.split("\n");
          for (const l of lines) {
             if (l.startsWith("data: ") && l !== "data: [DONE]") {
                try {
                    const data = JSON.parse(l.substring(6));
                    if (data.choices && data.choices[0].delta.content) {
                        fullContent += data.choices[0].delta.content;
                    }
                } catch {}
             }
          }
        }

        return new Response(JSON.stringify({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: { role: "assistant", content: fullContent },
                finish_reason: "stop"
            }],
            usage: { total_tokens: fullContent.length }
        }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
});

/**
 * 将 messages 数组拼接为 Prompt
 */
function convertMessagesToPrompt(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  // 简单拼接，可以根据模型偏好调整
  return messages.map((msg) => {
    return `${msg.role}: ${msg.content}`;
  }).join("\n\n");
}
