/**
 * Cloudflare Worker：把 TypeSafe Jev 端点反代到自己的域名。
 *
 * 官方端点对部分地区返回 451（Typesafe is not available in your region）。
 * 挂上这个 Worker 后，插件面板里把「端点 URL」填成你的域名、「代理地址」留空即可。
 *
 * 部署：Workers → 创建 Worker → 粘贴本文件 → 绑自定义域名
 * 可选：在 Worker 的「变量和机密」里加 JEV_API_KEY（真实 key 就不用在面板里填了）
 */
const TARGET = 'https://api.typesafe.ai';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const targetUrl = TARGET + url.pathname + url.search;

    const headers = new Headers(request.headers);
    // Host 必须改成目标域名，否则 TypeSafe 会拒
    headers.set('Host', new URL(TARGET).host);

    // Worker 里配了 JEV_API_KEY 就用它，否则透传客户端带的 key
    if (env.JEV_API_KEY) {
      headers.set('Authorization', `Bearer ${env.JEV_API_KEY}`);
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'follow',
    });

    // 非 2xx 也要原样返回 —— 插件靠状态码区分 401（key 错）/ 451（地区）/ 429（限流）
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
