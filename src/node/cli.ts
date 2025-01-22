import process from 'node:process'
import { bold, gray, green, red } from 'kolorist'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { build } from './build'

// eslint-disable-next-line no-unused-expressions
yargs(hideBin(process.argv))
  .scriptName('vite-ssg')
  .usage('$0 [args]')
  .command(
    'build',
    'Build SSG',
    args => args
      .option('script', {
        choices: ['sync', 'async', 'defer', 'async defer'] as const,
        describe: 'Rewrites script loading timing',
      })
      .option('mock', {
        type: 'boolean',
        describe: 'Mock browser globals (window, document, etc.) for SSG',
      })
      .option('config', {
        alias: 'c',
        type: 'string',
        describe: 'The vite config file to use',
      })
      .option('base', {
        alias: 'b',
        type: 'string',
        describe: 'The base path to render',
      }),
    async (args) => {
      const { config: configFile = undefined, ...ssgOptions } = args

      await build(ssgOptions, { configFile })
    },
  )
  .fail((msg, err, yargs) => {
    console.error(`\n${gray('[vite-ssg]')} ${bold(green(msg))}`)
    console.error(`\n${gray('[vite-ssg]')} ${bold(red('An internal error occurred.'))}`)
    yargs.exit(1, err)
  })
  .showHelpOnFail(false)
  .help()
  .argv

export {}
