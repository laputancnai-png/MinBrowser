const params = new URLSearchParams(location.search);
const code = params.get('code') || '';
const url = params.get('url') || '';

const MESSAGES = [
  [/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/, '找不到这个网站', '请检查网址是否拼写正确。'],
  [/INTERNET_DISCONNECTED|NETWORK_CHANGED/, '没有网络连接', '请检查你的网络后重新加载。'],
  [/CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE/, '网站拒绝了连接', '网站可能暂时不可用，请稍后再试。'],
  [/TIMED_OUT/, '连接超时', '网站响应太慢，请稍后再试。'],
  [/CERT|SSL/, '连接不安全', '这个网站的安全证书有问题，为保护你的数据已阻止访问。'],
  [/BLOCKED/, '已阻止访问', '这个请求被浏览器阻止了。'],
  [/RENDERER_CRASHED/, '这个网页崩溃了', '可能是网页占用内存过多或出错。点刷新按钮可以重新打开。'],
];

const [, title, detail] = MESSAGES.find(([re]) => re.test(code)) || [null, '无法打开这个网页', '加载时出错，请稍后重新加载。'];
document.getElementById('title').textContent = title;
document.getElementById('detail').textContent = detail;
document.getElementById('url').textContent = url;
document.getElementById('code').textContent = code;
document.title = title;
