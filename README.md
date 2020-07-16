# Homebridge Casambi Plugin

Adds support for devices controlled using the Casambi App (or any of its OEMs). Requires a developer API key to access the Cloud API. Refer to https://developer.casambi.com/ for more information.

The network in the Casambi App must have a gateway configured. A gateway can be any phone/tablet running the Casambi App and placed within the Bluetooth range of the lights at all times. The Cloud API servers communicate with the gateway device and use its Bluetooth radio to control the lights.

Right now the only supported device type are lights with the ability to turn them on/off, dim and change the color temperature.

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
            "loginMode": "network",
            "email": "your_network_login",
            "password": "your_network_password"
        }
    ]
}
```

## License

This project is licensed under the Apache Licence 2.0. See the [LICENSE](LICENSE) for details.
