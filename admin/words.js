/* global systemDictionary:true */
/* jshint node: true */
'use strict';

systemDictionary = {
    'x-touch adapter settings': {
        'en': 'Adapter settings for x-touch',
        'de': 'Adaptereinstellungen für x-touch',
        'ru': 'Настройки адаптера для x-touch',
        'pt': 'Configurações do adaptador para x-touch',
        'nl': 'Adapterinstellingen voor x-touch',
        'fr': "Paramètres d'adaptateur pour x-touch",
        'it': "Impostazioni dell'adattatore per x-touch",
        'es': 'Ajustes del adaptador para x-touch',
        'pl': 'Ustawienia adaptera dla x-touch',
        'zh-cn': 'x-touch的适配器设置'
    },
    'bind': {
        "en": "IP address to bind the port to",
        "de": "IP-Adresse, an die der Port gebunden werden soll",
        "ru": "IP-адрес для привязки порта к",
        "pt": "Endereço IP para ligar a porta",
        "nl": "IP-adres om de poort aan te binden",
        "fr": "Adresse IP à laquelle lier le port",
        "it": "Indirizzo IP a cui associare la porta",
        "es": "Dirección IP para vincular el puerto",
        "pl": "Adres IP, z którym ma zostać powiązany port",
        "zh-cn": "绑定端口的IP地址"
    },
    'deviceInactivityTimeout': {
        "en": "device inactivity timeout (in ms)",
        "de": "Zeitlimit für Inaktivität des Geräts (in ms)",
        "ru": "таймаут бездействия устройства (в мс)",
        "pt": "tempo limite de inatividade do dispositivo (em ms)",
        "nl": "time-out apparaat inactiviteit (in ms)",
        "fr": "timeout d'inactivité de l'appareil (en ms)",
        "it": "timeout di inattività del dispositivo (in ms)",
        "es": "tiempo de espera de inactividad del dispositivo (en ms)",
        "pl": "limit czasu bezczynności urządzenia (w ms)",
        "zh-cn": "设备不活动超时（以毫秒为单位）"
      },
      'deviceInactivityTimeout_tooltip': {
        "en": "set the time limit in ms after which the device will be reported offline if no status query is received",
        "de": "Legen Sie das Zeitlimit in ms fest, nach dem das Gerät offline gemeldet wird, wenn keine Statusabfrage empfangen wird",
        "ru": "установить лимит времени в мс, по истечении которого устройство будет отключено от сети, если запрос статуса не получен",
        "pt": "definir o limite de tempo em ms após o qual o dispositivo será relatado off-line se nenhuma consulta de status for recebida",
        "nl": "stel de tijdslimiet in ms in waarna het apparaat offline wordt gerapporteerd als er geen statusverzoek wordt ontvangen",
        "fr": "définir la limite de temps en ms après laquelle l'appareil sera signalé hors ligne si aucune demande d'état n'est reçue",
        "it": "impostare il limite di tempo in ms dopo il quale il dispositivo verrà segnalato offline se non viene ricevuta alcuna richiesta di stato",
        "es": "establezca el límite de tiempo en ms después del cual el dispositivo se informará fuera de línea si no se recibe ninguna consulta de estado",
        "pl": "ustaw limit czasu w ms, po którym urządzenie zostanie zgłoszone w trybie offline, jeśli nie zostanie odebrane żadne zapytanie o stan",
        "zh-cn": "设置时间限制（以毫秒为单位），如果未收到状态查询，设备将在此时间后报告离线"
      },
      "deviceGroups": {
        "en": "number of devicegroups which will be generated for use",
        "de": "Anzahl der Gerätegruppen, die zur Verwendung generiert werden",
        "ru": "количество групп устройств, которые будут созданы для использования",
        "pt": "número de grupos de dispositivos que serão gerados para uso",
        "nl": "aantal apparaatgroepen dat voor gebruik wordt gegenereerd",
        "fr": "nombre de groupes d'appareils qui seront générés pour être utilisés",
        "it": "numero di gruppi di dispositivi che verranno generati per l'uso",
        "es": "número de grupos de dispositivos que se generarán para su uso",
        "pl": "liczba grup urządzeń, które zostaną wygenerowane do użytku",
        "zh-cn": "生成供使用的设备组数"
      },
      "maxChannels": {
        "en": "maximum number of channels (8 to 32, in steps of 8)",
        "de": "maximale Anzahl von Kanälen (8 bis 32, in 8-er Schritten)",
        "ru": "максимальное количество каналов (от 8 до 32 с шагом 8)",
        "pt": "número máximo de canais (8 a 32, em etapas de 8)",
        "nl": "maximaal aantal kanalen (8 tot 32, in stappen van 8)",
        "fr": "nombre maximum de canaux (8 à 32, par pas de 8)",
        "it": "numero massimo di canali (da 8 a 32, a passi di 8)",
        "es": "número máximo de canales (8 a 32, en pasos de 8)",
        "pl": "maksymalna liczba kanałów (od 8 do 32, w krokach co 8)",
        "zh-cn": "最大通道数（8至32，以8为步长）"
      },
      "maxBanks": {
        "en": "maximum number of fader banks to switch",
        "de": "maximale Anzahl der zu schaltenden Faderbänke",
        "ru": "максимальное количество банков фейдеров для переключения",
        "pt": "número máximo de bancos de faders para mudar",
        "nl": "maximaal aantal faderbanken om te schakelen",
        "fr": "nombre maximum de banques de faders à changer",
        "it": "numero massimo di banchi di fader da cambiare",
        "es": "número máximo de bancos de faders para cambiar",
        "pl": "maksymalna liczba banków suwaków do przełączenia",
        "zh-cn": "最多可切换的推子库数量"
      },
      "createBank": {
        "en": "if checked the faderbanks will be newly created when parameters (maxBanks or maxChannels) changes",
        "de": "Wenn diese Option aktiviert ist, werden die Faderbanks neu erstellt, wenn sich die Parameter (maxBanks oder maxChannels) ändern",
        "ru": "если этот флажок установлен, банки фейдербанков будут создаваться заново при изменении параметров (maxBanks или maxChannels)",
        "pt": "se marcado, os faderbanks serão criados novamente quando os parâmetros (maxBanks ou maxChannels) mudarem",
        "nl": "indien aangevinkt, worden de faderbanks nieuw aangemaakt wanneer parameters (maxBanks of maxChannels) veranderen",
        "fr": "si coché, les faderbanks seront nouvellement créés lorsque les paramètres (maxBanks ou maxChannels) changent",
        "it": "se selezionato, i faderbank verranno creati nuovamente quando i parametri (maxBanks o maxChannels) cambiano",
        "es": "si se marca, los faderbanks se crearán nuevamente cuando los parámetros (maxBanks o maxChannels) cambien",
        "pl": "jeśli zaznaczone, banki faderbank zostaną utworzone na nowo, gdy parametry (maxBanks lub maxChannels) ulegną zmianie",
        "zh-cn": "如果选中，则在参数（maxBanks或maxChannels）更改时将重新创建渐变器"
      },
      "sendDelay": {
        "en": "time to wait between two midi messages (in ms)",
        "de": "Wartezeit zwischen zwei Midi-Nachrichten (in ms)",
        "ru": "время ожидания между двумя миди-сообщениями (в мс)",
        "pt": "tempo de espera entre duas mensagens midi (em ms)",
        "nl": "wachttijd tussen twee midi-berichten (in ms)",
        "fr": "temps d'attente entre deux messages midi (en ms)",
        "it": "tempo di attesa tra due messaggi midi (in ms)",
        "es": "tiempo de espera entre dos mensajes midi (en ms)",
        "pl": "czas oczekiwania między dwiema wiadomościami midi (w ms)",
        "zh-cn": "两条 MIDI 消息之间的等待时间（以毫秒为单位）"
      }
};