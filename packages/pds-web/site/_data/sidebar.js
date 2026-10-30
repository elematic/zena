/**
 * Documentation sidebar tree for `/docs/`.
 */
export default {
  '/docs/': [
    {
      text: 'Introduction',
      collapsed: false,
      items: [
        {text: 'Overview', link: '/docs/'},
        {text: 'Getting Started', link: '/docs/getting-started/'},
        {text: 'Publishing Packages', link: '/docs/publishing/'},
      ],
    },
    {
      text: 'Packages & Workspaces',
      collapsed: false,
      items: [
        {text: 'Package Manifests', link: '/docs/manifests/'},
        {text: 'Workspaces & Lockfiles', link: '/docs/workspaces/'},
      ],
    },
    {
      text: 'Organizations & Security',
      collapsed: false,
      items: [
        {text: 'Scopes, Orgs & Teams', link: '/docs/orgs-and-teams/'},
        {
          text: 'Approvals, Thresholds & Policies',
          link: '/docs/approvals-and-settings/',
        },
      ],
    },
    {
      text: 'Reference & Architecture',
      collapsed: false,
      items: [
        {text: 'CLI Commands', link: '/docs/cli/'},
        {text: 'AT Protocol Architecture', link: '/docs/architecture/'},
      ],
    },
  ],
};
