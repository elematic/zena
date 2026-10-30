---
layout: false
permalink: /home.html
hero:
  name: Packages for Zena
  title: Find and share packages for the Zena programming language.
  tagline: Explore community libraries, tools, and official packages — or publish your own with <code>zena publish</code>.
  actions:
    - theme: brand
      text: Get Started
      link: /docs/getting-started/
    - theme: alt
      text: Documentation
      link: /docs/
    - theme: alt
      text: Publish a Package
      link: /docs/publishing/
features:
  - icon: 🚀
    title: Getting Started
    details: Add dependencies with <code>zena add</code>, pin versions reproducibly in <code>zena-lock.json</code>, and import libraries by local alias.
    link: /docs/getting-started/
    linkText: Quickstart guide
  - icon: 🛡️
    title: Security & Labelers
    details: Protect releases with M-of-N maintainer approvals, signed Merkle proofs, and independent security labelers that flag vulnerabilities.
    link: /docs/approvals-and-settings/
    linkText: Security & policies
  - icon: 🔓
    title: No Registry Lock-In
    details: Decentralized by design with no single gatekeeper or namespace monopoly. Move hosts anytime without breaking existing dependents.
    link: /docs/publishing/
    linkText: Publishing workflow
  - icon: 👥
    title: Scopes, Orgs & Teams
    details: Organize packages under <code>@scope</code> namespaces and manage team roles with commitments that keep memberships private until members act.
    link: /docs/orgs-and-teams/
    linkText: Orgs & teams
  - icon: 📋
    title: Manifests & Workspaces
    details: Configure <code>zena-package.json</code>, library <code>exports</code>, conditional targets, minimal version selection, and multi-package workspaces.
    link: /docs/manifests/
    linkText: Manifest reference
  - icon: 🌐
    title: Built on AT Protocol
    details: Curious how it works under the hood? Every package and scope is an Atmosphere account with a DID, signed repository, and CAR archives.
    link: /docs/architecture/
    linkText: AT Protocol architecture
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
  {% slot "featured-packages" %}
</div>
