# Homebridge Casambi Plugin

Adds support for devices controlled using the Casambi App (or any of its OEMs). Requires a developer API key to access the Cloud API. Refer to https://developer.casambi.com/ for more information.

The network in the Casambi App must have a gateway configured. A gateway can be any phone/tablet also running the Casambi App and placed within the Bluetooth range of the lights at all times. The Cloud API servers communicate with the gateway device and use its Bluetooth radio to control the lights.

Right now the only supported devices are lights with the ability to turn them on/off, dim and change the color temperature.

## Installation

The easiest way to install the plugin is to use the web server built into Homebridge. Go to the *Plugins* tab, search for *homebridge-casambi* and click *Install*.

You can then click *Settings* on the installed plugin to set your API key and Casambi Network credentials.

If you prefer to edit Homebridge's `config.json` manually, here's an example:

```
{
    "bridge": { ... },
    "platforms": [
        {
            "platform": "Casambi",
            "apiKey": "your_api_key",
            "network": {
                "email": "your_network_login",
                "password": "your_network_password"
            },
        }
    ]
}
```

## License

This project is licensed under the Apache Licence 2.0. See the [LICENSE](LICENSE) for details.
