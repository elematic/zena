/**
 * Documentation sidebar tree for `/docs/`: what people do first, installing
 * and publishing, then security and teams, then what the AT Protocol gives
 * the package manager, and its details last.
 */
export default {
  '/docs/': [
    {
      text: 'Using Packages',
      collapsed: false,
      items: [
        {text: 'Overview', link: '/docs/'},
        {text: 'Installing Packages', link: '/docs/installing/'},
        {text: 'Workspaces & Lockfiles', link: '/docs/workspaces/'},
      ],
    },
    {
      text: 'Publishing',
      collapsed: false,
      items: [
        {text: 'Publishing Packages', link: '/docs/publishing/'},
        {text: 'Defining a Package', link: '/docs/manifests/'},
      ],
    },
    {
      text: 'Security & Teams',
      collapsed: false,
      items: [
        {text: 'Security', link: '/docs/security/'},
        {text: 'Approvals & Policies', link: '/docs/approvals-and-settings/'},
        {text: 'Scopes, Orgs & Teams', link: '/docs/orgs-and-teams/'},
      ],
    },
    {
      text: 'Decentralization',
      collapsed: false,
      items: [
        {text: 'Decentralized Packages', link: '/docs/decentralized/'},
        {text: 'AT Protocol Architecture', link: '/docs/architecture/'},
      ],
    },
    {
      text: 'Reference',
      collapsed: false,
      items: [{text: 'CLI Commands', link: '/docs/cli/'}],
    },
  ],
};
