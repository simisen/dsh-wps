// 由 index.html 包含。document.write 是同步的，保证 OnAddinLoad 被调用时依赖都已就绪。
document.write("<script language='javascript' src='js/api.js'></script>");
document.write("<script language='javascript' src='js/bootstrap.js'></script>");
