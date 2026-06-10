chrome.runtime.onInstalled.addListener((details) => {
  console.log('[nonecap] extension installed', details.reason);
});

export {};
