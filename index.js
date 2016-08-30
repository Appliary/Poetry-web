const Log = require( 'poetry/lib/methods/log.js' ),
    Server = require( 'poetry/lib/server.js' ),
    Events = require( 'poetry/lib/methods/events.js' );

let routes = {};

Server.register( {
    register: require( 'h2o2' )
}, ( err ) => {

    if ( err ) throw err;

    Events.on( 'web:route', {}, ( route, sender ) => {

        let r = route.method + ' ' + route.path;

        // New route
        if ( !routes[ r ] ) {

            Log.info( 'New route `' + r + '` registered for', sender.address );

            // Register the HOST ip
            routes[ r ] = [ sender.address ];

            // Add handler
            route.handler = handler( r );
            // Don't parse
            if ( !route.config ) route.config = {};
            route.config.payload = {
                parse: false
            };

            // Register to HAPI
            Server.route( route );

        }

        // Existing route -> load balancing
        else {

            Log.info( 'Balanced route `' + r + '` registered for', sender.address );

            // Add HOST ip
            if ( routes[ r ].indexOf( sender.address ) )
                routes[ r ].push( sender.address );

        }

    } );

    function handler( route ) {

        // Return the real handler
        return function ( req, reply ) {

            // Round robin'
            let host = routes[ route ].pop();
            routes[ route ].unshift( host );

            reply.proxy( {
                host: host,
                port: 8000,
                protocol: 'http',
                passThrough: true,
                onResponse: (err, res, request, reply) => {
                    reply(res)
                    .header('X-PoweredBy', 'Poetry')
                    .header('X-MicroServ', host);
                }
            } );

        };

    }

    Events.emit('web:init');

} );
