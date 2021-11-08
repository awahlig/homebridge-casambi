# Homebridge Casambi Plugin

Adds support for devices controlled using the Casambi App (or any of its OEMs). Requires a developer API key to access the Cloud API. Refer to [developer.casambi.com](https://developer.casambi.com/) for more information.

Right now, devices other than luminaires are not supported. Also, some features may not be accessible through HomeKit.

Supported luminaire features:
* on/off
* brightness
* color temperature
* [vertical](https://github.com/awahlig/homebridge-casambi/commit/7e6a0b548620621afd5e1d721f1a27e7a5c70df1) (optional, see config UI)

## Prerequisites

The network in the Casambi App must have a [gateway configured](https://support.casambi.com/support/solutions/articles/12000017046-how-to-enable-a-gateway-for-a-network-). A gateway can be any phone/tablet running the Casambi App and placed within the Bluetooth range of the lights at all times. The Cloud API servers communicate with the gateway device and use its Bluetooth radio to control the lights.

## Installation

It is recommended to install and configure this plugin using [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x#readme). Simply go to the *Plugins* tab and search for *homebridge-casambi*.

After installing you can click *Settings* to configure the plugin. Don't forget to restart Homebridge after making changes.

If you'd prefer to do it manually, run ```npm install -g homebridge-casambi``` to install the plugin and then update ```config.json``` of your Homebridge installation to configure it. Here's an example:

```
{
    "bridge": { ... },
    "platforms": [
        {
            "platform": "Casambi",
            "apiKey": "your_api_key",
            "loginMode": "network_or_user",
            "email": "your_network_login",
            "password": "your_network_password"
        }
    ]
}
```

|                 |                                                                                                                                                                                                                                   |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ```platform```  | Must be ```Casambi```.                                                                                                                                                                                                            |
| ```apiKey```    | Your Casambi Cloud API key. Refer to [developer.casambi.com](https://developer.casambi.com/) for more information on how to obtain one.                                                                                           |
| ```loginMode``` | Either ```network``` or ```user```, depending on whether you're providing network or user (site account) credentials. A site account allows access to devices from multiple networks (using Casambi App's *Sites* functionality). |
| ```email```     | The network/user login that you configured in the Casambi App.                                                                                                                                                                    |
| ```password```  | The network/user password.                                                                                                                                                                                                        |

## License

This project is licensed under the Apache Licence 2.0. See the [LICENSE](LICENSE) for details.
