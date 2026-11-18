---
layout: false
permalink: /home.html
hero:
  name: Packages for Zena
  title: Find and share packages for the Zena programming language.
  tagline: Add libraries and tools to your project with one command, or publish your own under a scope your team controls.
  actions:
    - theme: brand
      text: Install a Package
      link: /docs/installing/
    - theme: alt
      text: Publish a Package
      link: /docs/publishing/
    - theme: alt
      text: Documentation
      link: /docs/
features:
  - icon: 📦
    title: Installing Packages
    details: Add a package to your project by name and import its libraries. Every dependency is pinned, so every machine builds the same code, and nothing updates until you ask.
    link: /docs/installing/
    linkText: Install a package
  - icon: 🚀
    title: Publishing Packages
    details: Sign in with the account you already have, define your package in its manifest, and publish a release under your scope.
    link: /docs/publishing/
    linkText: Publish a package
  - icon: 🛡️
    title: Security
    details: Built to keep supply-chain attacks and malicious packages out of your project. Published versions never change, and a release can need approval from several maintainers.
    link: /docs/security/
    linkText: How packages are protected
  - icon: 🏷️
    title: Labels
    details: Coming soon. Anyone can run a labeler that marks packages as reviewed, deprecated or malicious, and you choose whose labels your projects follow.
    link: /docs/security/#planned
    linkText: Labels and what is planned
  - icon: 👥
    title: Scopes, Orgs & Teams
    details: Publish under a scope your organization owns, such as <code>acme</code>. Give members and teams roles, and keep who belongs private until they act.
    link: /docs/orgs-and-teams/
    linkText: Orgs & teams
  - icon: 🌐
    title: Decentralized
    details: No registry owns your packages. Each keeps its own identity and data wherever it is hosted. Built on the AT Protocol, the network Bluesky runs on.
    link: /docs/decentralized/
    linkText: Decentralized packages
---

<div class="home-page">
  <div class="hero hero-centered">
    <div class="container">
      <div class="main">
        <h1><span class="name clip">{{ hero.name }}</span></h1>
        <p class="title">{{ hero.title }}</p>
        <p class="tagline">{{ hero.tagline | safe }}</p>
        {% slot "search-form" %}
        <div class="actions">
          {%- for action in hero.actions %}
          <div class="action">
            <a class="button {{ action.theme }}" href="{{ action.link }}">{{ action.text }}</a>
          </div>
          {%- endfor %}
        </div>
        <div class="hero-shell" aria-label="Example of adding a package">
          <pre><code><span class="shell-prompt" aria-hidden="true">$ </span><span class="shell-cmd">zena pkg add acme:router</span>
<span class="shell-rail">┌</span>  zena pkg add acme:router
<span class="shell-ok">◇</span>  Found acme:router 1.4.2 <span class="shell-muted">did:plc:router…</span>
<span class="shell-ok">◇</span>  Updated zena-lock.json
<span class="shell-ok">◇</span>  1 package: <span class="shell-muted">1 fetched, 0 already in the cache, 0 failed</span>
<span class="shell-rail">└</span>  Added acme:router 1.4.2 to zena-package.json</code></pre>
        </div>
      </div>
    </div>
  </div>
  <div class="features">
    <div class="container">
      <div class="items">
        {%- for feature in features %}
        <div class="item grid-3">
          <a class="feature link" href="{{ feature.link }}">
            <article class="box">
              <div class="header">
                <div class="icon">{{ feature.icon }}</div>
                <h2 class="title">{{ feature.title }}</h2>
              </div>
              <p class="details">{{ feature.details | safe }}</p>
              <div class="link-text">
                <p class="link-text-value">{{ feature.linkText }} <span class="icon-arrow-right link-text-icon"></span></p>
              </div>
            </article>
          </a>
        </div>
        {%- endfor %}
      </div>
    </div>
  </div>
  {% slot "recent-packages" %}
</div>
