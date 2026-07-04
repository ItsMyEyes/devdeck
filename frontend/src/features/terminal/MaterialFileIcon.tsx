import fileIcon from 'material-icon-theme/icons/file.svg?url'
import folderIcon from 'material-icon-theme/icons/folder.svg?url'
import folderApiIcon from 'material-icon-theme/icons/folder-api.svg?url'
import folderClientIcon from 'material-icon-theme/icons/folder-client.svg?url'
import folderComponentsIcon from 'material-icon-theme/icons/folder-components.svg?url'
import folderConfigIcon from 'material-icon-theme/icons/folder-config.svg?url'
import folderDocsIcon from 'material-icon-theme/icons/folder-docs.svg?url'
import folderImagesIcon from 'material-icon-theme/icons/folder-images.svg?url'
import folderPublicIcon from 'material-icon-theme/icons/folder-public.svg?url'
import folderRoutesIcon from 'material-icon-theme/icons/folder-routes.svg?url'
import folderScriptsIcon from 'material-icon-theme/icons/folder-scripts.svg?url'
import folderServerIcon from 'material-icon-theme/icons/folder-server.svg?url'
import folderSrcIcon from 'material-icon-theme/icons/folder-src.svg?url'
import folderTestIcon from 'material-icon-theme/icons/folder-test.svg?url'
import folderToolsIcon from 'material-icon-theme/icons/folder-tools.svg?url'
import folderUtilsIcon from 'material-icon-theme/icons/folder-utils.svg?url'
import astroIcon from 'material-icon-theme/icons/astro.svg?url'
import cIcon from 'material-icon-theme/icons/c.svg?url'
import changelogIcon from 'material-icon-theme/icons/changelog.svg?url'
import consoleIcon from 'material-icon-theme/icons/console.svg?url'
import cssIcon from 'material-icon-theme/icons/css.svg?url'
import databaseIcon from 'material-icon-theme/icons/database.svg?url'
import dockerIcon from 'material-icon-theme/icons/docker.svg?url'
import eslintIcon from 'material-icon-theme/icons/eslint.svg?url'
import gitIcon from 'material-icon-theme/icons/git.svg?url'
import goIcon from 'material-icon-theme/icons/go.svg?url'
import goModIcon from 'material-icon-theme/icons/go-mod.svg?url'
import graphqlIcon from 'material-icon-theme/icons/graphql.svg?url'
import htmlIcon from 'material-icon-theme/icons/html.svg?url'
import imageIcon from 'material-icon-theme/icons/image.svg?url'
import javascriptIcon from 'material-icon-theme/icons/javascript.svg?url'
import jsonIcon from 'material-icon-theme/icons/json.svg?url'
import licenseIcon from 'material-icon-theme/icons/license.svg?url'
import lockIcon from 'material-icon-theme/icons/lock.svg?url'
import makefileIcon from 'material-icon-theme/icons/makefile.svg?url'
import markdownIcon from 'material-icon-theme/icons/markdown.svg?url'
import npmIcon from 'material-icon-theme/icons/npm.svg?url'
import pdfIcon from 'material-icon-theme/icons/pdf.svg?url'
import powershellIcon from 'material-icon-theme/icons/powershell.svg?url'
import prettierIcon from 'material-icon-theme/icons/prettier.svg?url'
import prismaIcon from 'material-icon-theme/icons/prisma.svg?url'
import pythonIcon from 'material-icon-theme/icons/python.svg?url'
import reactIcon from 'material-icon-theme/icons/react.svg?url'
import reactTsIcon from 'material-icon-theme/icons/react_ts.svg?url'
import readmeIcon from 'material-icon-theme/icons/readme.svg?url'
import rustIcon from 'material-icon-theme/icons/rust.svg?url'
import sassIcon from 'material-icon-theme/icons/sass.svg?url'
import settingsIcon from 'material-icon-theme/icons/settings.svg?url'
import svelteIcon from 'material-icon-theme/icons/svelte.svg?url'
import tomlIcon from 'material-icon-theme/icons/toml.svg?url'
import tsconfigIcon from 'material-icon-theme/icons/tsconfig.svg?url'
import typescriptIcon from 'material-icon-theme/icons/typescript.svg?url'
import viteIcon from 'material-icon-theme/icons/vite.svg?url'
import vueIcon from 'material-icon-theme/icons/vue.svg?url'
import xmlIcon from 'material-icon-theme/icons/xml.svg?url'
import yamlIcon from 'material-icon-theme/icons/yaml.svg?url'

const folderIcons: Record<string, string> = {
  api: folderApiIcon,
  assets: folderImagesIcon,
  client: folderClientIcon,
  components: folderComponentsIcon,
  config: folderConfigIcon,
  docs: folderDocsIcon,
  images: folderImagesIcon,
  public: folderPublicIcon,
  routes: folderRoutesIcon,
  scripts: folderScriptsIcon,
  server: folderServerIcon,
  src: folderSrcIcon,
  test: folderTestIcon,
  tests: folderTestIcon,
  tools: folderToolsIcon,
  utils: folderUtilsIcon,
}

const exactFileIcons: Record<string, string> = {
  'changelog.md': changelogIcon,
  dockerfile: dockerIcon,
  'go.mod': goModIcon,
  'go.sum': goModIcon,
  'license': licenseIcon,
  'license.md': licenseIcon,
  makefile: makefileIcon,
  'package-lock.json': lockIcon,
  'package.json': npmIcon,
  'pnpm-lock.yaml': lockIcon,
  'readme.md': readmeIcon,
  'tsconfig.json': tsconfigIcon,
  'vite.config.js': viteIcon,
  'vite.config.ts': viteIcon,
  'yarn.lock': lockIcon,
}

const extensionIcons: Record<string, string> = {
  astro: astroIcon,
  bash: consoleIcon,
  c: cIcon,
  cjs: javascriptIcon,
  conf: settingsIcon,
  config: settingsIcon,
  cpp: cIcon,
  css: cssIcon,
  env: settingsIcon,
  gif: imageIcon,
  go: goIcon,
  graphql: graphqlIcon,
  gql: graphqlIcon,
  h: cIcon,
  hpp: cIcon,
  html: htmlIcon,
  jpeg: imageIcon,
  jpg: imageIcon,
  js: javascriptIcon,
  json: jsonIcon,
  jsx: reactIcon,
  less: cssIcon,
  lock: lockIcon,
  md: markdownIcon,
  mjs: javascriptIcon,
  pdf: pdfIcon,
  png: imageIcon,
  prisma: prismaIcon,
  ps1: powershellIcon,
  py: pythonIcon,
  rs: rustIcon,
  sass: sassIcon,
  scss: sassIcon,
  sh: consoleIcon,
  sql: databaseIcon,
  svelte: svelteIcon,
  toml: tomlIcon,
  ts: typescriptIcon,
  tsx: reactTsIcon,
  vue: vueIcon,
  webp: imageIcon,
  xml: xmlIcon,
  yaml: yamlIcon,
  yml: yamlIcon,
  zsh: consoleIcon,
}

function fileIconFor(name: string) {
  const lower = name.toLowerCase()
  if (lower.startsWith('.env')) return settingsIcon
  if (lower.includes('eslint')) return eslintIcon
  if (lower.includes('prettier')) return prettierIcon
  if (lower === '.gitignore' || lower === '.gitattributes') return gitIcon
  if (exactFileIcons[lower]) return exactFileIcons[lower]
  const extension = lower.includes('.') ? lower.split('.').pop() ?? '' : ''
  return extensionIcons[extension] ?? fileIcon
}

export function MaterialFileIcon({
  name,
  isDir = false,
  size = 16,
}: {
  name: string
  isDir?: boolean
  size?: number
}) {
  const source = isDir ? folderIcons[name.toLowerCase()] ?? folderIcon : fileIconFor(name)
  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="flex-none select-none"
      style={{ width: size, height: size }}
    />
  )
}
