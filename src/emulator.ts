/** ******************************************************************************
 *  (c) 2020 Zondax GmbH
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ******************************************************************************* */
const path = require('path')
const Docker = require('dockerode')

export const DEV_CERT_PRIVATE_KEY = 'ff701d781f43ce106f72dc26a46b6a83e053b5d07bb3d4ceab79c91ca822a66b'
export const BOLOS_SDK = '/project/deps/nanos-secure-sdk'
export const DEFAULT_APP_PATH = '/project/app/bin'

export default class EmuContainer {
  private logging: boolean
  private readonly elfLocalPath: string
  private readonly name: string
  private startDelay: number
  private readonly image: any
  private libElfs: any
  private currentContainer: any | null

  constructor(elfLocalPath: string, libElfs: any, image: any, name: string) {
    // eslint-disable-next-line global-require
    this.image = image
    this.elfLocalPath = elfLocalPath
    this.libElfs = libElfs
    this.name = name
    this.logging = false
    this.startDelay = 100
  }

  static async killContainerByName(name: string) {
    const docker = new Docker()
    await new Promise(resolve => {
      docker.listContainers({ all: true, filters: { name: [name] } }, function (err: any, containers: any[]) {
        containers.forEach(function (containerInfo) {
          docker.getContainer(containerInfo.Id).remove({ force: true }, function () {
            // console.log("container removed");
          })
        })
        return resolve(true)
      })
    })
  }

  static async checkAndPullImage(imageName: string) {
    const docker = new Docker()
    await new Promise(resolve => {
      docker.pull(imageName, (err: any, stream: any) => {
        function onProgress(event: any) {
          // eslint-disable-next-line no-prototype-builtins
          const progress = event.hasOwnProperty('progress') ? event.progress : ''
          // eslint-disable-next-line no-prototype-builtins
          const status = event.hasOwnProperty('status') ? event.status : ''
          process.stdout.write(`[DOCKER] ${status}: ${progress}\n`)
        }

        function onFinished(err: any, output: any) {
          if (!err) {
            resolve(true)
          } else {
            process.stdout.write(`[DOCKER] ${err}\n`)
            process.exit(1)
          }
        }

        if (err) {
          process.stdout.write(`[DOCKER] ${err}\n`)
          throw new Error(err)
        }

        docker.modem.followProgress(stream, onFinished, onProgress)
      })
    })
  }

  log(message: string) {
    if (this.logging ?? false) {
      process.stdout.write(`${message}\n`)
    }
  }

  async runContainer(options: {
    logging: any
    startDelay: any
    X11: boolean
    custom: string
    model: string
    transportPort: string
    speculosApiPort: string
  }) {
    // eslint-disable-next-line global-require
    const docker = new Docker()

    this.logging = options.logging
    this.startDelay = options.startDelay

    const appFilename = path.basename(this.elfLocalPath)
    const appDir = path.dirname(this.elfLocalPath)

    const dirBindings = [`${appDir}:${DEFAULT_APP_PATH}`]

    let libArgs = ''
    Object.entries(this.libElfs).forEach(([libName, libPath]) => {
      const libFilename = path.basename(libPath)
      libArgs += ` -l ${libName}:${DEFAULT_APP_PATH}/${libFilename}`
    })

    let displaySetting = '--display headless'
    let displayEnvironment = ''

    // Disable X11 in CI
    if (!('CI' in process.env) || process.env.CI === 'false') {
      if ('X11' in options && options.X11) {
        displaySetting = ''
        dirBindings.push('/tmp/.X11-unix:/tmp/.X11-unix:ro')
      }

      displayEnvironment = process.env.DISPLAY ? process.env.DISPLAY : displayEnvironment
      if (process.platform === 'darwin') {
        displayEnvironment = 'host.docker.internal:0'
      }
    }

    let SDKoption = ''
    if (options.model === 'nanos') {
      this.log(`[ZEMU] Using NanoS SDK 2.0`)
      SDKoption = ' -k 2.0 '
    }

    let modelOptions = 'nanos'
    if (options.model) {
      modelOptions = options.model
    }

    let customOptions = ''
    if (options.custom) {
      customOptions = options.custom
    }

    const command = `/home/zondax/speculos/speculos.py --log-level speculos:DEBUG --color JADE_GREEN ${displaySetting} ${customOptions} -m ${modelOptions} ${SDKoption} ${DEFAULT_APP_PATH}/${appFilename} ${libArgs}`

    this.log(`[ZEMU] Command: ${command}`)

    const portBindings = {
      [`9998/tcp`]: [{ HostPort: options.transportPort }],
      [`5000/tcp`]: [{ HostPort: options.speculosApiPort }],
    }

    const environment = [
      `SCP_PRIVKEY=${DEV_CERT_PRIVATE_KEY}`,
      `BOLOS_SDK=${BOLOS_SDK}`,
      `BOLOS_ENV=/opt/bolos`,
      `DISPLAY=${displayEnvironment}`, // needed if X forwarding
    ]

    this.log(`[ZEMU] Creating Container`)

    this.currentContainer = await docker.createContainer({
      Image: this.image,
      name: this.name,
      Tty: true,
      Privileged: true,
      AttachStdout: true,
      AttachStderr: true,
      User: '1000',
      Env: environment,
      HostConfig: {
        PortBindings: portBindings,
        Binds: dirBindings,
      },
      Cmd: [command],
    })

    this.log(`[ZEMU] Connected ${this.currentContainer.id}`)

    if (this.logging) {
      this.currentContainer.attach({ stream: true, stdout: true, stderr: true }, function (err: any, stream: any) {
        stream.pipe(process.stdout)
      })
      this.log(`[ZEMU] Attached ${this.currentContainer.id}`)
    }

    await this.currentContainer.start({})

    this.log(`[ZEMU] Started ${this.currentContainer.id}`)
  }

  async stop() {
    if (this.currentContainer) {
      const container = this.currentContainer
      this.currentContainer = null
      this.log(`[ZEMU] Stopping container`)
      try {
        await container.stop({ t: 0 })
      } catch (e) {
        this.log(`[ZEMU] ${e}`)
      }
      this.log(`[ZEMU] Stopped`)
      try {
        await container.remove()
      } catch (e) {
        this.log(`[ZEMU] ${e}`)
      }
      this.log(`[ZEMU] Removed`)
    }
  }
}
