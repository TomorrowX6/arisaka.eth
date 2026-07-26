---
title: 利用AxisNow + Cloudflare实现国内自建CDN分流
published: 2026-07-24
description: 利用AxisNow + Cloudflare实现国内自建CDN分流，实现国内海外高速访问
image: https://i.ibb.co/nsM8GpBP/696f391c5b864.jpg
tags: [Cloudflare]
category: Tutorial
draft: false 
lang: zh
---

## 简介
AxisNow 是一个企业级边缘应用代理，为网站、应用程序和 API 提供安全，性能和连通性 — 所有这些都在您控制的基础设施上运行。<br>
免费用户拥有最多 3 个边缘，最多 10 个资源，最多 100 个别名，足够个人用户使用。<br>
首先你要有一台国内优化VPS，两个域名，一张外币卡（用于订阅Cloudflare Saas免费版），如果准备好了那就让我们开始<br>

## 名词解释
我们先来理解一下本文用到的一些名词术语。
- 代理域：是您提供给客户端访问的业务域名，也是实际在边缘进行反向代理的主机名。
- 虚拟域：该域名是专为 Cloudflare 创建的配置载体。需将 DNS 托管至 CF。
- 回源域：此域名在虚拟域中配置解析记录指向您的源服务器，并开启小黄云。
- 调度域：是工作在 DNS 层的解析域名。对于客户端/访客来说，并不需要知道该域名。
![](https://i.ibb.co/nsM8GpBP/696f391c5b864.jpg)

## 设置虚拟域（Cloudflare）
以我自己为例，我有两个域名（000.moe，746434.xyz），000.moe是用于访问的域名，746434.xyz是用于回源的域名
1. 将域名全部托管到Cloudflare
2. 添加一个虚拟域，在746434.xyz的DNS记录中添加A记录(source.746434.xyz)并指向你的VPS地址，并且`打开`小黄云
3. 进入Saas界面（依次点击746434.xyz - SSL/TLS - 自定义主机名），如果你第一次使用，需要先进行外币卡验证
4. 在回退源填入虚拟域（source.746434.xyz），等待验证成功
![1768901049791.png](https://i.ibb.co/NdRGd6SL/696f49ba4bd1a.png)

## 安装边缘节点（AxisNow）
AxisNow提供了一键安装脚本，依次点击边缘 - 新增 - 生成并复制，然后粘贴到SSH安装(注意：安装前请确保80 443端口未占用）

## 设置DNS路由（AxisNow）
依次点击策略 - 插件 - DNS路由<br>
选择AxisNow 托管，新增一个A记录路由（cn.alidns-3.com）<br>

点击域名进入路由规则管理，创建一条路由规则：<br>
1. 线路配置为 默认 。
2. 地址池配置为中国大陆优化的 EIP 地址。
3. 地址监控选择默认监控模版：Default China Network 。
4. 地址选取策略为最小延迟 。

![chrome_abYJbkNdTT.png](https://i.ibb.co/d4HfWTCF/696f4936dbcb7.png)

选择AxisNow 托管，新增一个CNAME记录路由（all.alidns-3.com）<br>

点击域名进入路由规则管理，创建一条路由规则:<br>
1. 创建 默认 线路路由规则
2. 地址池为 `cn.alidns-3.com`
3. 地址监控关联 无需选择
4. 地址选取策略 随机

再创建一条路由规则<br>
1. 创建 地域-境外 线路路由规则
2. 地址池为 `source.746434.xyz`
3. 地址监控关联 无需选择
4. 地址选取策略 随机

![1768900991471.png](https://i.ibb.co/xSks4n1C/696f498046cfc.png)

所得`all.alidns-3.com`即为最终调度域，我们所选择的是最简单国外CF，国内反代，边缘节点数量和其他配置自己按需添加，


## 设置代理域，回源域（Cloudflare）
1. 添加一个回源域，在746434.xyz的DNS记录中添加CNAME记录(cdn.746434.xyz)并指向调度域（all.alidns-3.com），并`关闭`小黄云
2. 添加一个代理域，在000.moe的DNS记录中添加CNAME记录(blog.000.moe)并指向回源域(cdn.746434.xyz)
3. 回到Saas界面，添加自定义主机名，自定义主机名为代理域（blog.000.moe），其他默认
4. 等待30s左右刷新，并添加TXT记录验证域名签发证书

## 设置反向代理（AxisNow）
1. 点击端点 - 资源，新增资源
2. 请求配置为代理域（blog.000.moe），协议HTTPS，端口443
3. 转发配置为实际部署域名或IP，我的博客是放在GitHub上的，所以填miuna-pic.github.io，协议HTTPS，端口443
4. 添加后如配置正确会自动签发证书

![1768901138579.png](https://i.ibb.co/bjXDSvtD/696f4a1429c4f.png)


## 关闭CF IPV6(可选)
如果你的边缘节点只有IPV4，当用户使用IPV6国内网络访问时会分流到Cloudflare，所以我们需要关闭IPV6兼容性

```sh
curl https://api.cloudflare.com/client/v4/zones/${区域 ID}/settings/ipv6 \
    -X PATCH \
    -H 'Content-Type: application/json' \
    -H "X-Auth-Email: ${登录邮箱}" \
    -H "X-Auth-Key: ${API 密匙}" \
    -d '{"value": "off"}'
```
注意:API密匙为Global API KEY

***最后，Engoy it!***
